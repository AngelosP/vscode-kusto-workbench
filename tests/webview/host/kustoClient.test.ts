import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
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
	const auth = {
		connectionId: TEST_CONNECTION.id,
		connectionIdentityKey: 'https://example.kusto.windows.net|',
		clusterEndpoint: 'https://example.kusto.windows.net',
		scopes: ['https://kusto.kusto.windows.net/.default'],
		account: { id: 'account-1', label: 'Account 1' },
		accountId: 'account-1',
		accountPartition: 'partition-account-1',
		preferenceMode: 'automatic',
	} as const;
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
	const executeWithAuthRetry = vi.fn(async (_connection: KustoConnection, operation: (client: any, operationAuth: typeof auth) => Promise<unknown>) => operation(fakeSdkClient, auth));
	const cancelQueryByClientActivityId = vi.fn(async () => undefined);
	(kustoClient as any).createRequestProperties = createRequestProperties;
	(kustoClient as any).getOrCreateCancelableClient = getOrCreateCancelableClient;
	(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;
	(kustoClient as any).cancelQueryByClientActivityId = cancelQueryByClientActivityId;
	return { kustoClient, fakeSdkClient, auth, createRequestProperties, getOrCreateCancelableClient, executeWithAuthRetry, cancelQueryByClientActivityId };
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

	it('exports HTTPS even when input uses http://', () => {
		const result = normalizeClusterEndpoint('http://mycluster.kusto.windows.net');
		expect(result).toBe('https://mycluster.kusto.windows.net');
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

	it('preserves non-public custom dotted hosts', () => {
		expect(normalizeClusterEndpoint('https://adx.contoso.com'))
			.toBe('https://adx.contoso.com');
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

// ── getDatabases diagnostics ─────────────────────────────────────────────────

describe('getDatabases diagnostics', () => {
	it('traces live discovery stages without logging database names', async () => {
		const trace = vi.fn();
		const logger = {
			trace,
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			show: vi.fn(),
			log: vi.fn(),
		};
		const kustoClient = new KustoQueryClient(undefined, logger);
		const executeWithAuthRetry = vi.fn(async (_connection: KustoConnection, operation: (client: any) => Promise<unknown>) => {
			return operation({
				execute: vi.fn(async () => ({
					primaryResults: [{
						columns: [{ name: 'DatabaseName', type: 'string' }],
						rows: function* rows() {
							yield { DatabaseName: 'SensitiveDatabaseName' };
						},
					}],
				})),
			});
		});
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		const result = await kustoClient.getDatabases(TEST_CONNECTION, true, {
			allowInteractive: false,
			traceId: 'trace-123',
			source: 'unit-test',
		});

		expect(result).toEqual(['SensitiveDatabaseName']);
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain('[database-list:trace-123] client.start source=unit-test');
		expect(traceText).toContain('client.cache.miss reason=force-refresh');
		expect(traceText).toContain('client.request.start');
		expect(traceText).toContain('command=.show databases');
		expect(traceText).toContain('client.response.shape columnCount=1 columnNames=DatabaseName');
		expect(traceText).toContain('client.success databaseCount=1');
		expect(traceText).not.toContain('SensitiveDatabaseName');
	});

	it('shares one physical discovery across concurrent same-target callers', async () => {
		const kustoClient = new KustoQueryClient();
		const gate = deferred<void>();
		const execute = vi.fn(async () => {
			await gate.promise;
			return {
				primaryResults: [{
					columns: [{ name: 'DatabaseName', type: 'string' }],
					rows: function* rows() { yield { DatabaseName: 'SensitiveDb' }; },
				}],
			};
		});
		const executeWithAuthRetry = vi.fn(async (
			_connection: KustoConnection,
			operation: (client: any) => Promise<unknown>,
		) => operation({ execute }));
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		const requests = Array.from({ length: 4 }, () => kustoClient.getDatabases(
			TEST_CONNECTION, true, { allowInteractive: false },
		));
		await vi.waitFor(() => expect(executeWithAuthRetry).toHaveBeenCalledOnce());
		gate.resolve();
		const results = await Promise.all(requests);

		expect(executeWithAuthRetry).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(results).toEqual(Array.from({ length: 4 }, () => ['SensitiveDb']));
	});

	it('preserves auth classification while keeping sensitive failure text out of logs', async () => {
		const trace = vi.fn();
		const error = vi.fn();
		const logger = {
			trace,
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error,
			show: vi.fn(),
			log: vi.fn(),
		};
		const kustoClient = new KustoQueryClient(undefined, logger);
		const sdkError = Object.assign(
			new Error('Database SecretDb rejected person@example.com Bearer TRACE_SECRET_TOKEN'),
			{ statusCode: 401 }
		);
		(kustoClient as any).executeWithAuthRetry = vi.fn(async () => { throw sdkError; });

		let caught: unknown;
		try {
			await kustoClient.getDatabases(TEST_CONNECTION, true, {
				allowInteractive: false,
				traceId: 'trace-auth-wrap',
				source: 'unit-test',
			});
		} catch (failure) {
			caught = failure;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(kustoClient.isAuthenticationError(caught)).toBe(true);
		expect((caught as Error).cause).toBe(sdkError);
		const logText = [...trace.mock.calls, ...error.mock.calls].map(([message]) => String(message)).join('\n');
		expect(logText).toContain('[database-list:trace-auth-wrap] client.failure');
		expect(logText).toContain('isAuthError=true');
		expect(logText).toContain('status=401');
		expect(logText).toContain('Failed to fetch databases. Trace ID: trace-auth-wrap');
		for (const secret of ['SecretDb', 'person@example.com', 'TRACE_SECRET_TOKEN']) {
			expect(logText).not.toContain(secret);
		}
	});
});

describe('getDatabaseSchema discovery policy', () => {
	it('forwards silent background auth policy and emits redacted bounded traces', async () => {
		const trace = vi.fn();
		const logger = { trace, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), log: vi.fn() };
		const kustoClient = new KustoQueryClient(undefined, logger);
		const executeWithAuthRetry = vi.fn(async (_connection: KustoConnection, operation: (client: any) => Promise<unknown>) => operation({
			execute: vi.fn(async () => ({
				primaryResults: [{ columns: [{ name: 'Schema', type: 'string' }], rows: function* rows() { yield { Schema: JSON.stringify({ Databases: { SensitiveDb: { Name: 'SensitiveDb', Tables: {}, ExternalTables: {}, MaterializedViews: {}, Functions: {}, EntityGroups: {}, Graphs: {}, MajorVersion: 1, MinorVersion: 0 } } }) }; } }],
			})),
		}));
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		await kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', true, {
			allowInteractive: false,
			traceId: 'schema-trace',
			source: 'supplemental-background',
		});

		expect(executeWithAuthRetry).toHaveBeenCalledWith(TEST_CONNECTION, expect.any(Function), expect.objectContaining({
			allowInteractive: false,
			traceId: 'schema-trace',
			operationName: 'get-schema',
		}));
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain('schema.start');
		expect(traceText).toContain('source=supplemental-background');
		expect(traceText).toContain('schema.success');
		expect(traceText).not.toContain('SensitiveDb');
		expect(traceText).not.toContain('Databases');
	});

	it('falls back to tabular discovery instead of caching an empty JSON schema', async () => {
		const kustoClient = new KustoQueryClient();
		const execute = vi.fn(async (_database: string, command: string) => command.endsWith('as json')
			? {
				primaryResults: [{
					columns: [{ name: 'Schema', type: 'string' }],
					rows: function* rows() { yield { Schema: JSON.stringify({ Databases: {} }) }; },
				}],
			}
			: {
				primaryResults: [{
					columns: [{ name: 'TableName' }, { name: 'ColumnName' }, { name: 'ColumnType' }],
					rows: function* rows() { yield { TableName: 'Events', ColumnName: 'EventName', ColumnType: 'string' }; },
				}],
			});
		const executeWithAuthRetry = vi.fn(async (
			_connection: KustoConnection,
			operation: (client: any) => Promise<unknown>,
			opts: { isSuccessfulResult?: (result: unknown) => boolean },
		) => {
			const response = await operation({ execute });
			if (execute.mock.calls.at(-1)?.[1]?.endsWith('as json')) {
				expect(opts.isSuccessfulResult).toBeUndefined();
			} else {
				expect(opts.isSuccessfulResult?.(response)).toBe(true);
			}
			return response;
		});
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		const result = await kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', true);

		expect(execute).toHaveBeenNthCalledWith(1, 'SensitiveDb', '.show database schema as json', expect.anything());
		expect(execute).toHaveBeenNthCalledWith(2, 'SensitiveDb', '.show database schema', expect.anything());
		expect(result.schema.tables).toEqual(['Events']);
		expect(result.schema.rawSchemaJson).toEqual(expect.objectContaining({
			Databases: expect.objectContaining({ SensitiveDb: expect.any(Object) }),
		}));
	});

	it('tries tabular schema on the same authenticated client before account retry', async () => {
		const globalState = new Map<string, unknown>();
		const secrets = new Map<string, string>();
		const context = {
			globalState: {
				get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) as T : fallback,
				update: async (key: string, value: unknown) => { globalState.set(key, value); },
			},
			secrets: {
				keys: async () => [...secrets.keys()],
				get: async (key: string) => secrets.get(key),
				store: async (key: string, value: string) => { secrets.set(key, value); },
				delete: async (key: string) => { secrets.delete(key); },
			},
			globalStorageUri: vscode.Uri.file(`/schema-first-use-${Date.now()}`),
			subscriptions: [],
		} as any;
		const kustoClient = new KustoQueryClient(context);
		const accountPartition = (kustoClient as any).authPreferences.getAccountPartition(undefined, 'account-1');
		const auth = {
			connectionId: TEST_CONNECTION.id,
			connectionIdentityKey: 'https://example.kusto.windows.net|',
			clusterEndpoint: 'https://example.kusto.windows.net',
			scopes: ['https://kusto.kusto.windows.net/.default'],
			account: { id: 'account-1', label: 'Account 1' },
			accountId: 'account-1',
			accountPartition,
			authSessionGeneration: 0,
			preferenceMode: 'automatic',
		};
		const sdkClient = {
			close: vi.fn(),
			execute: vi.fn(async (_database: string, command: string) => command.endsWith('as json')
				? {
					primaryResults: [{
						columns: [{ name: 'Schema', type: 'string' }],
						rows: function* rows() { yield { Schema: JSON.stringify({ Databases: {} }) }; },
					}],
				}
				: {
					primaryResults: [{
						columns: [{ name: 'TableName' }, { name: 'ColumnName' }, { name: 'ColumnType' }],
						rows: function* rows() { yield { TableName: 'Events', ColumnName: 'EventName', ColumnType: 'string' }; },
					}],
				}),
		};
		(kustoClient as any).getOrCreateClient = vi.fn(async () => sdkClient);
		(kustoClient as any).authContextByClient.set(sdkClient, auth);
		(kustoClient as any).clients.set(TEST_CONNECTION.id, { client: sdkClient, auth });
		(kustoClient as any).getAccountCandidates = vi.fn(async () => [{ id: 'account-2', label: 'Account 2' }]);
		const requestSession = vi.fn(async () => ({ session: undefined }));
		(kustoClient as any).requestSession = requestSession;

		const result = await kustoClient.getDatabaseSchema(
			TEST_CONNECTION,
			'SensitiveDb',
			true,
			{ allowInteractive: false },
		);

		expect(sdkClient.execute.mock.calls.map(call => call[1])).toEqual([
			'.show database schema as json',
			'.show database schema',
		]);
		expect(result.schema.tables).toEqual(['Events']);
		expect(requestSession).not.toHaveBeenCalled();
		expect(sdkClient.close).toHaveBeenCalledOnce();
		kustoClient.dispose();
	});

	it('shares one physical discovery across concurrent same-target callers', async () => {
		const kustoClient = new KustoQueryClient();
		const gate = deferred<void>();
		const rawSchema = {
			Plugins: [],
			Databases: {
				SensitiveDb: {
					Name: 'SensitiveDb',
					Tables: { Events: { Name: 'Events', OrderedColumns: [{ Name: 'EventName', Type: 'string', CslType: 'string' }] } },
					ExternalTables: {}, MaterializedViews: {}, Functions: {}, EntityGroups: {}, Graphs: {},
					MajorVersion: 1, MinorVersion: 0,
				},
			},
		};
		const execute = vi.fn(async () => {
			await gate.promise;
			return {
				primaryResults: [{
					columns: [{ name: 'DatabaseSchema', type: 'string' }],
					rows: function* rows() { yield { DatabaseSchema: JSON.stringify(rawSchema) }; },
				}],
			};
		});
		const executeWithAuthRetry = vi.fn(async (
			_connection: KustoConnection,
			operation: (client: any) => Promise<unknown>,
		) => operation({ execute }));
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		const requests = Array.from({ length: 4 }, () => kustoClient.getDatabaseSchema(
			TEST_CONNECTION, 'SensitiveDb', false, { allowInteractive: false },
		));
		await vi.waitFor(() => expect(executeWithAuthRetry).toHaveBeenCalledOnce());
		gate.resolve();
		const results = await Promise.all(requests);

		expect(executeWithAuthRetry).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(results.every(result => result.schema === results[0].schema)).toBe(true);
		expect(results[0].schema.tables).toEqual(['Events']);
	});

	it('does not coalesce an owner-gated schema request with a direct request', async () => {
		const runWithLeaveNoTraceSnapshotLock = vi.fn(async (run: (policy: unknown) => Promise<unknown>) => run({}));
		const connectionManager = {
			runWithLeaveNoTraceSnapshotLock,
			onDidChangeConnections: vi.fn(() => ({ dispose: vi.fn() })),
			getConnections: vi.fn(() => [TEST_CONNECTION]),
		};
		const kustoClient = new KustoQueryClient(undefined, undefined, connectionManager as any);
		const gate = deferred<void>();
		let physicalStarts = 0;
		const rawSchema = {
			Plugins: [],
			Databases: {
				SensitiveDb: {
					Name: 'SensitiveDb', Tables: {}, ExternalTables: {}, MaterializedViews: {}, Functions: {},
					EntityGroups: {}, Graphs: {}, MajorVersion: 1, MinorVersion: 0,
				},
			},
		};
		const execute = vi.fn(async () => {
			physicalStarts++;
			if (physicalStarts === 2) gate.resolve();
			await gate.promise;
			return {
				primaryResults: [{
					columns: [{ name: 'DatabaseSchema', type: 'string' }],
					rows: function* rows() { yield { DatabaseSchema: JSON.stringify(rawSchema) }; },
				}],
			};
		});
		const operationAuth = {
			accountPartition: 'partition-1', authSessionGeneration: 1,
		};
		const executeWithAuthRetry = vi.fn(async (
			_connection: KustoConnection,
			operation: (client: any, auth: any) => Promise<unknown>,
		) => operation({ execute }, operationAuth));
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;
		const dispatchAuthenticated = vi.fn(async (
			_connection: KustoConnection,
			_accountPartition: string,
			_authSessionGeneration: number,
			_policy: unknown,
			dispatch: () => Promise<unknown>,
		) => dispatch());

		await Promise.all([
			kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', true),
			kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', true, { dispatchAuthenticated }),
		]);

		expect(executeWithAuthRetry).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
		expect(dispatchAuthenticated).toHaveBeenCalledOnce();
	});

	it('does not enqueue cache deletion for a newly added connection', async () => {
		let connectionListener: ((change: any) => void) | undefined;
		const globalState = new Map<string, unknown>();
		const context = {
			globalState: {
				get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) as T : fallback,
				update: async (key: string, value: unknown) => { globalState.set(key, value); },
			},
			secrets: {
				keys: async () => [], get: async () => undefined,
				store: async () => undefined, delete: async () => undefined,
			},
			globalStorageUri: vscode.Uri.file(`/connection-lifecycle-${Date.now()}`),
			subscriptions: [],
		} as any;
		const connectionManager = {
			getConnections: vi.fn(() => []),
			onDidChangeConnections: vi.fn((listener: (change: any) => void) => {
				connectionListener = listener;
				return { dispose: vi.fn() };
			}),
		} as any;
		const client = new KustoQueryClient(context, undefined, connectionManager);
		const clearConnection = vi.fn(async () => undefined);
		(client as any).connectionCache = { clearConnection };

		connectionListener?.({ type: 'added', connection: TEST_CONNECTION });
		await flushPromises();
		expect(clearConnection).not.toHaveBeenCalled();

		connectionListener?.({ type: 'removed', connection: TEST_CONNECTION });
		await flushPromises();
		expect(clearConnection).toHaveBeenCalledWith(TEST_CONNECTION.id);
		client.dispose();
	});

	it('fails closed before warm metadata cache lookup when a dispatch gate has no manager', async () => {
		const kustoClient = new KustoQueryClient();
		(kustoClient as any).getAccountPartition = vi.fn(() => 'partition-1');
		const schemaKey = (kustoClient as any).schemaCacheKey(TEST_CONNECTION, 'partition-1', 'SensitiveDb');
		(kustoClient as any).schemaCache.set(schemaKey, {
			schema: {
				tables: [], columnTypesByTable: {}, rawSchemaJson: {
					Plugins: [], Databases: {
						SensitiveDb: {
							Name: 'SensitiveDb', Tables: {}, ExternalTables: {}, MaterializedViews: {}, Functions: {},
							EntityGroups: {}, Graphs: {}, MajorVersion: 1, MinorVersion: 0,
						},
					},
				},
			},
			timestamp: Date.now(),
		});
		const databaseKey = (kustoClient as any).databaseCacheKey(TEST_CONNECTION, 'partition-1');
		(kustoClient as any).databaseCache.set(databaseKey, { databases: ['SensitiveDb'], timestamp: Date.now() });
		const dispatchAuthenticated = vi.fn();

		await expect(kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', false, { dispatchAuthenticated }))
			.rejects.toThrow('requires a connection manager');
		await expect(kustoClient.getDatabasesWithIdentity(TEST_CONNECTION, false, { dispatchAuthenticated }))
			.rejects.toThrow('requires a connection manager');
		expect(dispatchAuthenticated).not.toHaveBeenCalled();
	});

	it('does not run the tabular fallback after schema discovery is cancelled', async () => {
		const kustoClient = new KustoQueryClient();
		const executeWithAuthRetry = vi.fn(async () => {
			throw new QueryCancelledError('Cached values changed while schema discovery was running');
		});
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		await expect(kustoClient.getDatabaseSchema(TEST_CONNECTION, 'Samples', true))
			.rejects.toBeInstanceOf(QueryCancelledError);
		expect(executeWithAuthRetry).toHaveBeenCalledOnce();
	});

	it('does not return or cache a schema that settles after disposal', async () => {
		const kustoClient = new KustoQueryClient();
		const response = deferred<any>();
		const auth = {
			connectionId: TEST_CONNECTION.id,
			connectionIdentityKey: 'https://example.kusto.windows.net|',
			clusterEndpoint: 'https://example.kusto.windows.net',
			scopes: ['https://kusto.kusto.windows.net/.default'],
			account: { id: 'account-1', label: 'Account 1' },
			accountId: 'account-1',
			accountPartition: 'partition-account-1',
			authSessionGeneration: 0,
			preferenceMode: 'automatic',
		};
		const sdkClient = {
			close: vi.fn(),
			execute: vi.fn(async (_database: string, command: string) => {
				if (command.endsWith('as json')) return response.promise;
				throw new Error('Tabular schema must not run after disposal');
			}),
		};
		(kustoClient as any).getOrCreateClient = vi.fn(async () => sdkClient);
		(kustoClient as any).authContextByClient.set(sdkClient, auth);
		(kustoClient as any).clients.set(TEST_CONNECTION.id, { client: sdkClient, auth });
		(kustoClient as any).getAccountCandidates = vi.fn(async () => []);

		const pending = kustoClient.getDatabaseSchema(TEST_CONNECTION, 'SensitiveDb', true);
		await vi.waitFor(() => expect(sdkClient.execute).toHaveBeenCalledOnce());
		kustoClient.dispose();
		response.resolve({
			primaryResults: [{
				columns: [{ name: 'DatabaseSchema' }],
				rows: function* rows() { yield { DatabaseSchema: JSON.stringify({ Databases: {} }) }; },
			}],
		});

		await expect(pending).rejects.toThrow('disposed');
		expect(sdkClient.execute.mock.calls.map(call => call[1])).toEqual(['.show database schema as json']);
		expect(sdkClient.close).toHaveBeenCalledOnce();
		expect((kustoClient as any).schemaCache.size).toBe(0);
	});
});

describe('metadata disposal fencing', () => {
	it('does not return or cache databases that settle after disposal', async () => {
		const kustoClient = new KustoQueryClient();
		const response = deferred<any>();
		const executeWithAuthRetry = vi.fn(() => response.promise);
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;
		(kustoClient as any).createRequestProperties = vi.fn(async () => ({ clientRequestId: 'disposed-databases' }));

		const pending = kustoClient.getDatabases(TEST_CONNECTION, true);
		await vi.waitFor(() => expect(executeWithAuthRetry).toHaveBeenCalledOnce());
		kustoClient.dispose();
		response.resolve({
			primaryResults: [{
				columns: [{ name: 'DatabaseName' }],
				rows: function* rows() { yield { DatabaseName: 'SensitiveDb' }; },
			}],
		});

		await expect(pending).rejects.toThrow('disposed');
		expect((kustoClient as any).databaseCache.size).toBe(0);
	});
});

// ── executeQueryCancelable ───────────────────────────────────────────────────

describe('executeQueryCancelable', () => {
	it('captures the current Leave No Trace revision in the physical dispatch identity', async () => {
		const { kustoClient } = createCancelableClientHarness();
		(kustoClient as any).connectionManager = {
			getConnectionIncarnation: () => 3,
			prepareLeaveNoTraceDispatch: async (_clusterUrl: string, start: (revision: number) => unknown) => ({
				value: start(7), revocationGeneration: 7,
			}),
		};
		const onDispatch = vi.fn();

		const handle = kustoClient.executeQueryCancelable(
			TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn', { onDispatch },
		);
		await handle.promise;

		expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({
			dispatchAttempt: 1,
			connectionRevision: 3,
			leaveNoTraceRevision: 7,
			accountPartition: 'partition-account-1',
			clientActivityId: handle.clientActivityId,
		}));
	});

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

		expect(executeWithAuthRetry).toHaveBeenCalledOnce();
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
		expect(cancelQueryByClientActivityId).toHaveBeenCalledWith(
			TEST_CONNECTION,
			'Samples',
			handle.clientActivityId,
			'Canceled from Kusto Workbench',
			expect.objectContaining({ accountPartition: 'partition-account-1' }),
		);
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
		const trace = vi.fn();
		const logger = {
			trace,
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			show: vi.fn(),
			log: vi.fn(),
		};
		const kustoClient = new KustoQueryClient(undefined, logger);
		const client = { execute: vi.fn(async () => 'ok') };
		const getOrCreateClient = vi.fn(async () => client);
		(kustoClient as any).getOrCreateClient = getOrCreateClient;

		const result = await (kustoClient as any).executeWithAuthRetry(
			TEST_CONNECTION,
			(c: typeof client) => c.execute(),
			{ allowInteractive: false, traceId: 'auth-trace', operationName: 'get-databases' }
		);

		expect(result).toBe('ok');
		expect(getOrCreateClient).toHaveBeenCalledWith(TEST_CONNECTION, { interactiveIfNeeded: false, traceId: 'auth-trace' });
		expect(client.execute).toHaveBeenCalledTimes(1);
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain('[database-list:auth-trace] auth.execute.start operation=get-databases');
		expect(traceText).toContain('allowInteractive=false');
		expect(traceText).toContain('auth.operation.start attempt=initial');
		expect(traceText).toContain('auth.operation.complete attempt=initial');
	});

	it('traces when an auth failure cannot use interactive recovery', async () => {
		const trace = vi.fn();
		const logger = {
			trace,
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			show: vi.fn(),
			log: vi.fn(),
		};
		const kustoClient = new KustoQueryClient(undefined, logger);
		const authError = Object.assign(new Error('Request rejected'), { statusCode: 401 });
		(kustoClient as any).getOrCreateClient = vi.fn(async () => { throw authError; });

		await expect((kustoClient as any).executeWithAuthRetry(
			TEST_CONNECTION,
			async () => 'unused',
			{ allowInteractive: false, traceId: 'auth-failure', operationName: 'get-databases' }
		)).rejects.toBe(authError);

		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain('[database-list:auth-failure] auth.operation.failed attempt=initial isAuthError=true');
		expect(traceText).toContain('status=401');
		expect(traceText).toContain('auth.retry.clients-evicted');
		expect(traceText).toContain('auth.retry.known-accounts.start knownAccountCount=0');
		expect(traceText).toContain('auth.retry.interactive.skipped reason=interactive-disabled');
	});

	it('owns the clear-preference then force-new-session interactive retry sequence', async () => {
		const kustoClient = new KustoQueryClient();
		const authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
		const clearPreferenceClient = { id: 'clear-preference' };
		const forceNewSessionClient = { id: 'force-new-session' };
		(kustoClient as any).getOrCreateClient = vi.fn(async () => { throw authError; });
		const auth = (accountId: string) => ({
			connectionId: TEST_CONNECTION.id,
			connectionIdentityKey: TEST_CONNECTION.clusterUrl,
			clusterEndpoint: TEST_CONNECTION.clusterUrl,
			scopes: ['https://kusto.kusto.windows.net/.default'],
			account: { id: accountId, label: accountId },
			accountId,
			accountPartition: `partition-${accountId}`,
			preferenceMode: 'automatic',
		});
		const createClientWithRetry = vi.fn()
			.mockResolvedValueOnce({ client: clearPreferenceClient, auth: auth('account-1') })
			.mockResolvedValueOnce({ client: forceNewSessionClient, auth: auth('account-2') });
		(kustoClient as any).createClientWithRetry = createClientWithRetry;
		const operation = vi.fn(async (client: { id: string }) => {
			if (client === clearPreferenceClient) {
				throw authError;
			}
			return 'ok';
		});

		await expect((kustoClient as any).executeWithAuthRetry(
			TEST_CONNECTION,
			operation,
			{ allowInteractive: true, traceId: 'interactive-retry' }
		)).resolves.toBe('ok');

		expect(createClientWithRetry).toHaveBeenNthCalledWith(1, TEST_CONNECTION, expect.objectContaining({
			interactiveIfNeeded: true,
			promptMode: 'clearPreference',
			skipSilent: true,
		}));
		expect(createClientWithRetry).toHaveBeenNthCalledWith(2, TEST_CONNECTION, expect.objectContaining({
			interactiveIfNeeded: true,
			promptMode: 'forceNewSession',
			skipSilent: true,
		}));
	});

	it('does not force a new session after the clear-preference prompt is cancelled', async () => {
		const kustoClient = new KustoQueryClient();
		const authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
		(kustoClient as any).getOrCreateClient = vi.fn(async () => { throw authError; });
		const cancellation = new QueryCancelledError('Sign-in cancelled');
		const createClientWithRetry = vi.fn(async () => { throw cancellation; });
		(kustoClient as any).createClientWithRetry = createClientWithRetry;

		await expect((kustoClient as any).executeWithAuthRetry(
			TEST_CONNECTION,
			async () => 'unused',
			{ allowInteractive: true, traceId: 'interactive-cancel' }
		)).rejects.toBe(cancellation);

		expect(createClientWithRetry).toHaveBeenCalledTimes(1);
		expect(createClientWithRetry).toHaveBeenCalledWith(TEST_CONNECTION, expect.objectContaining({
			promptMode: 'clearPreference',
		}));
	});
});