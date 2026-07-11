import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { SchemaService } from '../../../src/host/queryEditorSchema';
import type { KustoConnection } from '../../../src/host/connectionManager';
import { isAuthError } from '../../../src/host/kustoClientUtils';
import { SCHEMA_CACHE_TTL_MS, SCHEMA_CACHE_VERSION } from '../../../src/host/schemaCache';

function makeRawSchema(database: string) {
	return {
		Plugins: [],
		Databases: {
			[database]: {
				Tables: {
					Events: {
						EntityType: 'Table',
						OrderedColumns: {
							TIMESTAMP: { Name: 'TIMESTAMP', CslType: 'datetime' },
							EventName: { Name: 'EventName', CslType: 'string' },
						},
					},
				},
				Functions: {},
			},
		},
	};
}

function createService(connection: KustoConnection) {
	const messages: any[] = [];
	const rawSchemaJson = makeRawSchema('TelemetryDb');
	const getDatabaseSchema = vi.fn(async () => ({
		schema: {
			tables: ['Events'],
			columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } },
			rawSchemaJson,
		},
		fromCache: false,
	}));
	const service = new SchemaService({
		context: {
			globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), `kusto-workbench-query-editor-schema-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)),
			globalState: {
				get: vi.fn(() => true),
				update: vi.fn(async () => undefined),
			},
		} as any,
		kustoClient: { getDatabaseSchema, isAuthenticationError: isAuthError } as any,
		connectionManager: { getConnections: vi.fn(() => [connection]) } as any,
		output: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any,
		postMessage: (message: unknown) => { messages.push(message); },
		formatQueryExecutionErrorForUser: (error: unknown) => String(error),
		findConnection: vi.fn(() => connection),
	});
	return { service, messages, getDatabaseSchema };
}

describe('SchemaService cross-cluster schema requests', () => {
	it('matches a full ADX host request to a regional short-form configured connection', async () => {
		const connection: KustoConnection = {
			id: 'semantic-westus',
			name: 'Synthetic West US',
			clusterUrl: 'https://semantic-current.westus',
		};
		const { service, messages, getDatabaseSchema } = createService(connection);

		await service.handleCrossClusterSchemaRequest('semantic-current.westus.kusto.windows.net', 'TelemetryDb', 'query_1', 'token_1', 'background', 'trace-1');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', false, expect.objectContaining({
			allowInteractive: false,
			traceId: 'trace-1',
			source: 'supplemental-background',
		}));
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'semantic-current.westus.kusto.windows.net',
			clusterUrl: 'https://semantic-current.westus',
			database: 'TelemetryDb',
			boxId: 'query_1',
			requestToken: 'token_1',
			requestSource: 'background',
			deliverySource: 'fresh',
			rawSchemaJson: makeRawSchema('TelemetryDb'),
		}));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaError' }));
	});

	it('matches a regional short-form request to a full ADX host configured connection', async () => {
		const connection: KustoConnection = {
			id: 'semantic-westus-full',
			name: 'Synthetic West US Full',
			clusterUrl: 'https://semantic-current.westus.kusto.windows.net',
		};
		const { service, messages, getDatabaseSchema } = createService(connection);

		await service.handleCrossClusterSchemaRequest('semantic-current.westus', 'TelemetryDb', 'query_2', 'token_2', 'autocomplete', 'trace-2');
		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', false, expect.objectContaining({ allowInteractive: true }));

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'semantic-current.westus',
			clusterUrl: 'https://semantic-current.westus.kusto.windows.net',
			database: 'TelemetryDb',
			boxId: 'query_2',
			requestToken: 'token_2',
			requestSource: 'autocomplete',
		}));
	});

	it('delivers fetched supplemental schema before best-effort persistence failure', async () => {
		const connection: KustoConnection = { id: 'fresh', name: 'Fresh', clusterUrl: 'https://fresh.kusto.windows.net' };
		const { service, messages } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		vi.spyOn(service, 'saveCachedSchemaToDisk').mockRejectedValue(new Error('disk full'));

		await service.handleCrossClusterSchemaRequest('fresh', 'TelemetryDb', 'query_3', 'token_3', 'background', 'trace-3');

		expect(messages).toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaData', boxId: 'query_3', requestToken: 'token_3' }));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaError', boxId: 'query_3' }));
	});

	it('rejects version-mismatched supplemental cache and fetches silently', async () => {
		const connection: KustoConnection = { id: 'versioned', name: 'Versioned', clusterUrl: 'https://versioned.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: { tables: ['Old'], columnTypesByTable: {}, rawSchemaJson: makeRawSchema('TelemetryDb') },
			timestamp: Date.now(),
			version: SCHEMA_CACHE_VERSION - 1,
		});

		await service.handleCrossClusterSchemaRequest('versioned', 'TelemetryDb', 'query_4', 'token_4', 'background', 'trace-4');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', true, expect.objectContaining({ allowInteractive: false }));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaData', deliverySource: 'disk-cache-fresh' }));
	});

	it('classifies wrapped background authentication failures without prompting', async () => {
		const connection: KustoConnection = { id: 'auth', name: 'Auth', clusterUrl: 'https://auth.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		getDatabaseSchema.mockRejectedValueOnce(new Error('Failed to fetch database schema', {
			cause: Object.assign(new Error('forbidden'), { statusCode: 403 }),
		}));

		await service.handleCrossClusterSchemaRequest('auth', 'TelemetryDb', 'query_auth', 'token_auth', 'background', 'trace-auth');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', false, expect.objectContaining({ allowInteractive: false }));
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaError',
			requestToken: 'token_auth',
			failureKind: 'auth-required',
		}));
	});

	it('classifies wrapped message-only unauthorized failures as auth-required', async () => {
		const connection: KustoConnection = { id: 'auth-message', name: 'Auth Message', clusterUrl: 'https://auth-message.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		getDatabaseSchema.mockRejectedValueOnce(new Error('Failed to fetch database schema', {
			cause: new Error('Unauthorized request for this cluster'),
		}));

		await service.handleCrossClusterSchemaRequest('auth-message', 'TelemetryDb', 'query_auth_message', 'token_auth_message', 'background', 'trace-auth-message');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaError',
			requestToken: 'token_auth_message',
			failureKind: 'auth-required',
		}));
	});

	it('keeps stale supplemental fallback loaded when silent refresh fails', async () => {
		const connection: KustoConnection = { id: 'stale', name: 'Stale', clusterUrl: 'https://stale.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: makeRawSchema('TelemetryDb') },
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});
		getDatabaseSchema.mockRejectedValueOnce(new Error('offline'));

		await service.handleCrossClusterSchemaRequest('stale', 'TelemetryDb', 'query_5', 'token_5', 'background', 'trace-5');

		expect(messages).toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaData', deliverySource: 'disk-cache-stale', requestToken: 'token_5' }));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaError', requestToken: 'token_5' }));
		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', true, expect.objectContaining({ allowInteractive: false }));
	});

	it('forces an interactive live refresh instead of redelivering stale disk cache for autocomplete', async () => {
		const connection: KustoConnection = { id: 'stale-interactive', name: 'Stale Interactive', clusterUrl: 'https://stale-interactive.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: makeRawSchema('TelemetryDb') },
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});

		await service.handleCrossClusterSchemaRequest('stale-interactive', 'TelemetryDb', 'query_6', 'token_6', 'autocomplete', 'trace-6');

		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaData', deliverySource: 'disk-cache-stale' }));
		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', true, expect.objectContaining({
			allowInteractive: true,
			traceId: 'trace-6',
			source: 'supplemental-autocomplete',
		}));
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			requestToken: 'token_6',
			requestSource: 'autocomplete',
			deliverySource: 'fresh',
		}));
	});
});

describe('SchemaService primary schema preparation', () => {
	const connection: KustoConnection = {
		id: 'primary',
		name: 'Primary',
		clusterUrl: 'https://primary.kusto.windows.net',
	};

	it('posts a terminal background-refresh error with usable fallback capability', async () => {
		const { service, messages, getDatabaseSchema } = createService(connection);
		const cachedSchema = {
			tables: ['Events'],
			columnTypesByTable: { Events: { TIMESTAMP: 'datetime' } },
			rawSchemaJson: makeRawSchema('TelemetryDb'),
		};
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: cachedSchema,
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});
		getDatabaseSchema.mockRejectedValueOnce(new Error('offline'));

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_1', false, 'schema_1');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData',
			boxId: 'query_1',
			requestToken: 'schema_1',
			schemaMeta: expect.objectContaining({ refreshState: 'scheduled', isStale: true, isBackgroundRefresh: true }),
		}));
		await vi.waitFor(() => {
			expect(messages).toContainEqual(expect.objectContaining({
				type: 'schemaError',
				boxId: 'query_1',
				requestToken: 'schema_1',
				silent: true,
				isBackgroundRefresh: true,
				refreshState: 'failed',
				hasUsableFallback: true,
			}));
		});
	});

	it('delivers a fetched schema even when persisting the cache fails', async () => {
		const { service, messages } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		vi.spyOn(service, 'saveCachedSchemaToDisk').mockRejectedValue(new Error('disk full'));

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_2', false, 'schema_2');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData',
			boxId: 'query_2',
			requestToken: 'schema_2',
			schemaMeta: expect.objectContaining({ refreshState: 'completed' }),
		}));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'schemaError', boxId: 'query_2' }));
	});

	it('terminates a tokened schema request when the connection no longer exists', async () => {
		const { service, messages } = createService(connection);
		(service as any).host.findConnection = vi.fn(() => undefined);

		await service.prefetchSchema('missing', 'TelemetryDb', 'query_3', false, 'schema_missing');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError',
			boxId: 'query_3',
			connectionId: 'missing',
			requestToken: 'schema_missing',
		}));
	});
});
