import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { scheduler } from 'node:timers/promises';
import { SchemaService } from '../../../src/host/queryEditorSchema';
import * as schemaIndexUtils from '../../../src/host/schemaIndexUtils';
import type { KustoConnection } from '../../../src/host/connectionManager';
import { isAuthError } from '../../../src/host/kustoClientUtils';
import { SCHEMA_CACHE_TTL_MS, SCHEMA_CACHE_VERSION, schemaCacheKey, writeCachedSchemaToDisk } from '../../../src/host/schemaCache';

const schemaTestStorageUris: vscode.Uri[] = [];

afterEach(async () => {
	const storageUris = schemaTestStorageUris.splice(0);
	await Promise.all(storageUris.map(async uri => {
		try { await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }); } catch { /* already absent */ }
	}));
});

function makeRawSchema(database: string) {
	return {
		Plugins: [],
		Databases: {
			[database]: {
				Name: database,
				Tables: {
					Events: {
						Name: 'Events',
						EntityType: 'Table',
						OrderedColumns: [
							{ Name: 'TIMESTAMP', Type: 'System.DateTime', CslType: 'datetime' },
							{ Name: 'EventName', Type: 'System.String', CslType: 'string' },
						],
					},
				},
				ExternalTables: {},
				MaterializedViews: {},
				EntityGroups: {},
				MajorVersion: 1,
				MinorVersion: 0,
				Functions: {},
				Graphs: {},
			},
		},
	};
}

function createService(connection: KustoConnection) {
	const messages: any[] = [];
	const rawSchemaJson = makeRawSchema('TelemetryDb');
	const globalStorageUri = vscode.Uri.file(path.join(os.tmpdir(), `kusto-workbench-query-editor-schema-test-${Date.now()}-${Math.random().toString(16).slice(2)}`));
	schemaTestStorageUris.push(globalStorageUri);
	const getDatabaseSchema = vi.fn(async () => ({
		schema: {
			tables: ['Events'],
			columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } },
			rawSchemaJson,
		},
		fromCache: false,
		accountPartition: 'test-partition',
	}));
	const getDatabases = vi.fn(async () => ['TelemetryDb']);
	const getAccountPartition = vi.fn<() => string | undefined>(() => 'test-partition');
	let currentConnection = connection;
	const service = new SchemaService({
		context: {
			globalStorageUri,
			globalState: {
				get: vi.fn(() => true),
				update: vi.fn(async () => undefined),
			},
		} as any,
		kustoClient: { getDatabases, getDatabaseSchema, getAccountPartition, isAuthenticationError: isAuthError } as any,
		connectionManager: { getConnections: vi.fn(() => currentConnection ? [currentConnection] : []) } as any,
		output: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any,
		postMessage: (message: unknown) => { messages.push(message); },
		formatQueryExecutionErrorForUser: (error: unknown) => String(error),
		findConnection: vi.fn(() => currentConnection),
	});
	return {
		service, messages, getDatabases, getDatabaseSchema, getAccountPartition, globalStorageUri,
		setConnection: (next: KustoConnection) => { currentConnection = next; },
	};
}

describe('SchemaService cross-cluster schema requests', () => {
	it.each(['primary', 'cached', 'background', 'failover', 'tools'] as const)('retires %s schema signing before any stale cache write or delivery', async route => {
		const connection: KustoConnection = { id: 'signing', name: 'Signing', clusterUrl: 'https://signing.kusto.windows.net' };
		const { service, messages, getDatabaseSchema, setConnection } = createService(connection);
		const cached = {
			schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime' } }, rawSchemaJson: makeRawSchema('TelemetryDb') },
			timestamp: route === 'background' ? 1 : Date.now(), version: SCHEMA_CACHE_VERSION,
			connectionId: connection.id, accountPartition: 'test-partition',
		};
		const read = vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(
			route === 'cached' || route === 'background' ? cached : undefined,
		);
		if (route === 'failover') {
			read.mockResolvedValueOnce(undefined).mockResolvedValue(cached);
			getDatabaseSchema.mockRejectedValue(new Error('offline'));
		}
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<string>();
		let signatures = 0;
		const signature = vi.spyOn(schemaIndexUtils, 'getAutocompleteSchemaSignatureAsync').mockImplementation(() => {
			if (route === 'background' && ++signatures === 1) return Promise.resolve('cached-signature');
			started.resolve();
			return held.promise;
		});
		try {
			const request = route === 'tools'
				? service.refreshSchemaForTools(connection.clusterUrl, connection.id, [{ boxId: 'query_1', database: 'TelemetryDb', requestToken: 'old' }])
				: service.prefetchSchema(connection.id, 'TelemetryDb', 'query_1', false, 'old');
			await started.promise;
			const background = [...(service as any).backgroundSchemaRefreshes.values()].map((entry: any) => entry.promise);
			expect(write).not.toHaveBeenCalled();
			const priorMessages = messages.slice();
			setConnection({ ...connection, clusterUrl: 'https://replacement.kusto.windows.net' });
			held.resolve('fresh-signature');
			await request;
			await Promise.all(background);
			expect(write).not.toHaveBeenCalled();
			expect(messages).toEqual(priorMessages);
			expect(messages).toHaveLength(route === 'background' ? 1 : 0);
		} finally {
			held.resolve('cleanup');
			signature.mockRestore();
		}
	});

	it.each([
		{ phase: 'before schema preparation', heldYield: 1, cached: false },
		{ phase: 'before cache serialization', heldYield: 2, cached: false },
		{ phase: 'before cached signature', heldYield: 1, cached: true },
		{ phase: 'before cached delivery', heldYield: 2, cached: true },
	])('yields $phase and retires a changed connection before effects', async ({ heldYield, cached }) => {
		const connection: KustoConnection = { id: 'yielding', name: 'Yielding', clusterUrl: 'https://yielding.kusto.windows.net' };
		const { service, messages, getDatabaseSchema, setConnection } = createService(connection);
		const read = vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(cached ? {
			schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime' } }, rawSchemaJson: makeRawSchema('TelemetryDb') },
			timestamp: Date.now(), version: SCHEMA_CACHE_VERSION,
			connectionId: connection.id, accountPartition: 'test-partition',
		} : undefined);
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
		const signature = vi.spyOn(schemaIndexUtils, 'getAutocompleteSchemaSignatureAsync');
		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		let yields = 0;
		const yielding = vi.spyOn(scheduler, 'yield').mockImplementation(() => {
			if (++yields === heldYield) { started.resolve(); return held.promise; }
			return Promise.resolve();
		});
		try {
			const request = service.prefetchSchema(connection.id, 'TelemetryDb', 'old_target', false, 'old_token');
			await started.promise;
			if (heldYield === 1) expect(signature).not.toHaveBeenCalled();
			else expect(signature).toHaveBeenCalledTimes(1);
			expect(messages).toEqual([]);
			expect(write).not.toHaveBeenCalled();
			setConnection({ ...connection, clusterUrl: 'https://replacement.kusto.windows.net' });
			held.resolve();
			await request;
			expect(write).not.toHaveBeenCalled();
			expect(messages).toEqual([]);
			read.mockResolvedValue(undefined);
			await service.prefetchSchema(connection.id, 'TelemetryDb', 'new_target', false, 'new_token');
			expect(getDatabaseSchema).toHaveBeenCalledTimes(cached ? 1 : 2);
			expect(write).toHaveBeenCalledTimes(1);
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({ type: 'schemaData', boxId: 'new_target', requestToken: 'new_token', clusterUrl: 'https://replacement.kusto.windows.net' });
		} finally {
			held.resolve();
			yielding.mockRestore();
			signature.mockRestore();
		}
	});

	it('shares primary schema preparation and cache publication across concurrent sections', async () => {
		const connection: KustoConnection = { id: 'shared', name: 'Shared', clusterUrl: 'https://shared.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		const read = vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk');
		const fetched = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
		getDatabaseSchema.mockReturnValue(fetched.promise);
		const requests = Array.from({ length: 4 }, (_, index) => service.prefetchSchema(
			connection.id, 'TelemetryDb', `query_${index}`, false, `token_${index}`, {},
			{ sectionInstanceId: `instance_${index}`, targetGeneration: index + 1 },
		));
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
		await new Promise(resolve => setTimeout(resolve, 0));
		fetched.resolve({ schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } }, rawSchemaJson: makeRawSchema('TelemetryDb') }, fromCache: false, accountPartition: 'test-partition' });
		await Promise.all(requests);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0][0]).toBe(schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'test-partition'));
		const deliveries = messages.filter(message => message.type === 'schemaData');
		expect(deliveries).toHaveLength(4);
		for (let index = 0; index < 4; index++) expect(deliveries).toContainEqual(expect.objectContaining({
			boxId: `query_${index}`, requestToken: `token_${index}`, sectionInstanceId: `instance_${index}`,
			targetGeneration: index + 1, accountPartition: 'test-partition',
			schemaMeta: expect.objectContaining({ deliveryKind: 'fresh', workerUpdateNeeded: true, forceRefresh: false }),
		}));
		expect(new Set(deliveries.map(message => message.schemaMeta.schemaSignature)).size).toBe(1);
		read.mockRestore();
		await service.prefetchSchema(connection.id, 'TelemetryDb', 'query_5', false, 'token_5');
		expect(getDatabaseSchema).toHaveBeenCalledTimes(1);
		expect(messages.at(-1)).toMatchObject({ type: 'schemaData', boxId: 'query_5', schemaMeta: { deliveryKind: 'cache' } });
	});

	it('retires failed shared primary preparation and keeps cache-write failure best effort', async () => {
		const connection: KustoConnection = { id: 'retry', name: 'Retry', clusterUrl: 'https://retry.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		const fetched = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
		getDatabaseSchema.mockReturnValueOnce(fetched.promise);
		const first = service.prefetchSchema(connection.id, 'TelemetryDb', 'query_1', false, 'token_1');
		const second = service.prefetchSchema(connection.id, 'TelemetryDb', 'query_2', false, 'token_2');
		await new Promise(resolve => setTimeout(resolve, 0));
		fetched.reject(new Error('offline'));
		await Promise.all([first, second]);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(1);
		expect(messages.filter(message => message.type === 'schemaError').map(message => message.requestToken)).toEqual(['token_1', 'token_2']);
		vi.spyOn(service, 'saveCachedSchemaToDisk').mockRejectedValue(new Error('disk full'));
		await Promise.all([
			service.prefetchSchema(connection.id, 'TelemetryDb', 'query_3', false, 'token_3'),
			service.prefetchSchema(connection.id, 'TelemetryDb', 'query_4', false, 'token_4'),
		]);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(messages.filter(message => message.type === 'schemaData').map(message => message.requestToken)).toEqual(['token_3', 'token_4']);
		expect((service as any).host.output.warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('failed to persist schema'))).toHaveLength(1);
	});

	it('keeps refresh and account identities separate while resolving an unknown account once', async () => {
		const connection: KustoConnection = { id: 'identity', name: 'Identity', clusterUrl: 'https://identity.kusto.windows.net' };
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
		await Promise.all([
			service.prefetchSchema(connection.id, 'TelemetryDb', 'ordinary', false, 'ordinary'),
			service.prefetchSchema(connection.id, 'TelemetryDb', 'forced', true, 'forced'),
		]);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(messages.find(message => message.boxId === 'ordinary')?.schemaMeta.forceRefresh).toBe(false);
		expect(messages.find(message => message.boxId === 'forced')?.schemaMeta.forceRefresh).toBe(true);
		const accounts = (service as any).host.kustoClient.getAccountPartition;
		accounts.mockReturnValueOnce('partition-a').mockReturnValueOnce('partition-b');
		const result = { schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } }, rawSchemaJson: makeRawSchema('TelemetryDb') }, fromCache: false, accountPartition: 'partition-a' };
		getDatabaseSchema.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, accountPartition: 'partition-b' });
		await Promise.all([
			service.prefetchSchema(connection.id, 'TelemetryDb', 'account_a', false, 'account_a'),
			service.prefetchSchema(connection.id, 'TelemetryDb', 'account_b', false, 'account_b'),
		]);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(4);
		expect(write.mock.calls.slice(-2).map(call => call[0])).toEqual([
			schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'partition-a'),
			schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'partition-b'),
		]);
		accounts.mockReturnValue(undefined);
		await Promise.all([
			service.prefetchSchema(connection.id, 'TelemetryDb', 'unresolved_a', false, 'unresolved_a'),
			service.prefetchSchema(connection.id, 'TelemetryDb', 'unresolved_b', false, 'unresolved_b'),
		]);
		expect(getDatabaseSchema).toHaveBeenCalledTimes(5);
		expect(write.mock.calls.at(-1)?.[0]).toBe(schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'test-partition'));
	});

	it('does not publish or persist a shared preparation after its connection identity changes', async () => {
		const connection: KustoConnection = { id: 'changed', name: 'Changed', clusterUrl: 'https://changed.kusto.windows.net' };
		const { service, messages, getDatabaseSchema, setConnection } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
		const fetched = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
		getDatabaseSchema.mockReturnValueOnce(fetched.promise);
		const request = service.prefetchSchema(connection.id, 'TelemetryDb', 'old_target', false, 'old_target');
		await new Promise(resolve => setTimeout(resolve, 0));
		setConnection({ ...connection, clusterUrl: 'https://replacement.kusto.windows.net' });
		fetched.resolve({ schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } }, rawSchemaJson: makeRawSchema('TelemetryDb') }, fromCache: false, accountPartition: 'test-partition' });
		await request;
		expect(write).not.toHaveBeenCalled();
		expect(messages).toEqual([]);
		await service.prefetchSchema(connection.id, 'TelemetryDb', 'new_target', false, 'new_target');
		expect(getDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(messages.at(-1)).toMatchObject({ type: 'schemaData', boxId: 'new_target', clusterUrl: 'https://replacement.kusto.windows.net' });
	});

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

	it('keeps stale supplemental fallback loaded and publishes a refresh terminal when silent refresh fails', async () => {
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
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaError',
			requestToken: 'token_5',
			requestSource: 'background',
			failureKind: 'fetch-failed',
		}));
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

	describe('primary auth mode', () => {
		it.each([
			{ resolved: true, automaticFirst: true },
			{ resolved: true, automaticFirst: false },
			{ resolved: false, automaticFirst: true },
			{ resolved: false, automaticFirst: false },
		])('isolates mixed modes and preserves same-mode joins through failure/retry: resolved=$resolved automaticFirst=$automaticFirst', async ({ resolved, automaticFirst }) => {
			const { service, messages, getDatabaseSchema, getAccountPartition } = createService(connection);
			getAccountPartition.mockReturnValue(resolved ? 'test-partition' : undefined);
			vi.spyOn(service as unknown as { getCachedSchemaFromDiskByCluster: () => Promise<undefined> }, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
			const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
			const firstFetch = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
			const secondFetch = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
			const retryFetch = Promise.withResolvers<Awaited<ReturnType<typeof getDatabaseSchema>>>();
			getDatabaseSchema.mockReturnValueOnce(firstFetch.promise).mockReturnValueOnce(secondFetch.promise).mockReturnValueOnce(retryFetch.promise);
			const firstReason = automaticFirst ? 'automatic' : 'autocomplete';
			const secondReason = automaticFirst ? 'autocomplete' : 'automatic';
			const work: Promise<void>[] = [];
			const request = (reason: string, token: string) => {
				const pending = service.prefetchSchema(connection.id, 'TelemetryDb', token, false, token, { reason });
				work.push(pending);
				return pending;
			};
			const result = {
				schema: { tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime', EventName: 'string' } }, rawSchemaJson: makeRawSchema('TelemetryDb') },
				fromCache: false, accountPartition: 'test-partition',
			};
			try {
				const first = [request(firstReason, 'first_1'), request(firstReason, 'first_2')];
				request(secondReason, 'second_1');
				request(secondReason, 'second_2');
				await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledTimes(2));
				expect(getDatabaseSchema).toHaveBeenNthCalledWith(1, connection, 'TelemetryDb', false, {
					allowInteractive: !automaticFirst, source: 'primary-schema',
				});
				expect(getDatabaseSchema).toHaveBeenNthCalledWith(2, connection, 'TelemetryDb', false, {
					allowInteractive: automaticFirst, source: 'primary-schema',
				});
				firstFetch.reject(new Error('late first-mode failure'));
				await Promise.all(first);
				expect(messages.filter(message => message.type === 'schemaError').map(message => message.requestToken)).toEqual(['first_1', 'first_2']);
				request(secondReason, 'second_join');
				request(firstReason, 'retry_1');
				request(firstReason, 'retry_2');
				await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledTimes(3));
				expect(getDatabaseSchema).toHaveBeenNthCalledWith(3, connection, 'TelemetryDb', false, {
					allowInteractive: !automaticFirst, source: 'primary-schema',
				});
				secondFetch.resolve(result);
				retryFetch.resolve(result);
				await Promise.all(work);
				expect(getDatabaseSchema).toHaveBeenCalledTimes(3);
				expect(write).toHaveBeenCalledTimes(2);
				expect(messages.filter(message => message.type === 'schemaData').map(message => message.requestToken).sort())
					.toEqual(['retry_1', 'retry_2', 'second_1', 'second_2', 'second_join']);
				for (const message of messages.filter(message => message.type === 'schemaData')) {
					expect(message).toMatchObject({ accountPartition: 'test-partition', schemaMeta: { deliveryKind: 'fresh' } });
				}
			} finally {
				firstFetch.resolve(result);
				secondFetch.resolve(result);
				retryFetch.resolve(result);
				await Promise.all(work);
			}
		});

		it.each([undefined, 'unrecognized-origin', 'automatic '])('keeps unspecified or unknown reason %s interactive', async reason => {
			const { service, messages, getDatabaseSchema } = createService(connection);
			vi.spyOn(service as unknown as { getCachedSchemaFromDiskByCluster: () => Promise<undefined> }, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
			vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
			await service.prefetchSchema(connection.id, 'TelemetryDb', 'legacy', false, 'legacy', { reason });
			expect(getDatabaseSchema).toHaveBeenCalledExactlyOnceWith(connection, 'TelemetryDb', false, {
				allowInteractive: true, source: 'primary-schema',
			});
			expect(messages).toEqual([expect.objectContaining({ type: 'schemaData', requestToken: 'legacy' })]);
		});
	});

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

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_1', false, 'schema_1', {}, {
			sectionInstanceId: 'instance-1', targetGeneration: 4,
		});

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData',
			boxId: 'query_1',
			requestToken: 'schema_1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 4,
			schemaMeta: expect.objectContaining({ refreshState: 'scheduled', isStale: true, isBackgroundRefresh: true }),
		}));
		await vi.waitFor(() => {
			expect(messages).toContainEqual(expect.objectContaining({
				type: 'schemaError',
				boxId: 'query_1',
				requestToken: 'schema_1',
				sectionInstanceId: 'instance-1',
				targetGeneration: 4,
				silent: true,
				isBackgroundRefresh: true,
				refreshState: 'failed',
				hasUsableFallback: true,
			}));
		});
	});

	it('posts a terminal when stale primary refresh resolves under a different account partition', async () => {
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: {
				tables: ['Events'],
				columnTypesByTable: { Events: { TIMESTAMP: 'datetime' } },
				rawSchemaJson: makeRawSchema('TelemetryDb'),
			},
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});
		getDatabaseSchema.mockResolvedValueOnce({
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: makeRawSchema('TelemetryDb') },
			fromCache: false,
			accountPartition: 'rotated-partition',
		});

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_rotated', false, 'schema_rotated', {}, {
			sectionInstanceId: 'instance-rotated', targetGeneration: 7,
		});

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData', boxId: 'query_rotated', requestToken: 'schema_rotated',
			schemaMeta: expect.objectContaining({ refreshState: 'scheduled' }),
		}));
		await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_rotated', requestToken: 'schema_rotated',
			sectionInstanceId: 'instance-rotated', targetGeneration: 7,
			refreshState: 'failed', hasUsableFallback: true,
		})));
	});

	it('upgrades a compact disk cache when a forced refresh fails', async () => {
		const { service, messages, getDatabaseSchema, globalStorageUri } = createService(connection);
		await writeCachedSchemaToDisk(
			globalStorageUri,
			schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'test-partition'),
			{
				schema: {
					tables: ['Events'],
					columnTypesByTable: { Events: { TIMESTAMP: 'System.DateTime', EventName: 'System.String' } },
				},
				timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
				version: SCHEMA_CACHE_VERSION,
				clusterUrl: connection.clusterUrl,
				database: 'TelemetryDb',
				connectionId: connection.id,
				accountPartition: 'test-partition',
			},
		);
		getDatabaseSchema.mockRejectedValueOnce(new Error('offline'));

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_cached', true, 'schema_cached');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData',
			boxId: 'query_cached',
			requestToken: 'schema_cached',
			schema: expect.objectContaining({
				rawSchemaJson: expect.objectContaining({
					Databases: expect.objectContaining({
						TelemetryDb: expect.objectContaining({
							Tables: expect.objectContaining({ Events: expect.any(Object) }),
						}),
					}),
				}),
			}),
			schemaMeta: expect.objectContaining({
				fromCache: true,
				isFailoverToCache: true,
				hasRawSchemaJson: true,
				refreshState: 'failed',
			}),
		}));
		expect(messages).not.toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_cached',
		}));
	});

	it('ignores a malformed fresh cache and continues to the live schema fetch', async () => {
		const { service, messages, getDatabaseSchema, globalStorageUri } = createService(connection);
		await writeCachedSchemaToDisk(
			globalStorageUri,
			schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'test-partition'),
			{
				schema: { tables: [], columnTypesByTable: {}, functions: [{} as any], rawSchemaJson: {} },
				timestamp: Date.now(),
				version: SCHEMA_CACHE_VERSION,
				clusterUrl: connection.clusterUrl,
				database: 'TelemetryDb',
				connectionId: connection.id,
				accountPartition: 'test-partition',
			},
		);

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_malformed', false, 'schema_malformed');

		expect(getDatabaseSchema).toHaveBeenCalledOnce();
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData', boxId: 'query_malformed',
			schemaMeta: expect.objectContaining({ deliveryKind: 'fresh' }),
		}));
	});

	it('retains a stale worker-ready cache when background refresh returns unusable schema', async () => {
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: {
				tables: ['Events'], columnTypesByTable: { Events: { CachedOnly: 'string' } },
				rawSchemaJson: makeRawSchema('TelemetryDb'),
			},
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});
		getDatabaseSchema.mockResolvedValueOnce({
			schema: { tables: [], columnTypesByTable: {}, rawSchemaJson: {} },
			fromCache: false,
			accountPartition: 'test-partition',
		});

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_invalid_refresh', false, 'schema_invalid_refresh');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData', boxId: 'query_invalid_refresh',
			schemaMeta: expect.objectContaining({ refreshState: 'scheduled', isStale: true }),
		}));
		await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_invalid_refresh', silent: true,
			isBackgroundRefresh: true, refreshState: 'failed', hasUsableFallback: true,
		})));
		expect(messages).not.toContainEqual(expect.objectContaining({
			type: 'schemaData', boxId: 'query_invalid_refresh',
			schemaMeta: expect.objectContaining({ refreshState: 'completed' }),
		}));
	});

	it('ignores a cache file whose stored identity does not match its target key', async () => {
		const { service, messages, getDatabaseSchema, globalStorageUri } = createService(connection);
		await writeCachedSchemaToDisk(
			globalStorageUri,
			schemaCacheKey(connection.clusterUrl, 'TelemetryDb', connection.id, 'test-partition'),
			{
				schema: { tables: ['WrongIdentity'], columnTypesByTable: { WrongIdentity: { Id: 'long' } } },
				timestamp: Date.now(),
				version: SCHEMA_CACHE_VERSION,
				clusterUrl: connection.clusterUrl,
				database: 'TelemetryDb',
				connectionId: 'another-connection',
				accountPartition: 'test-partition',
			},
		);

		await service.prefetchSchema('primary', 'TelemetryDb', 'query_identity', false, 'schema_identity');

		expect(getDatabaseSchema).toHaveBeenCalledOnce();
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData', boxId: 'query_identity',
			schema: expect.objectContaining({ tables: ['Events'] }),
		}));
	});

	it('does not suppress background refresh for a lifecycle-owned reserved-prefix section', async () => {
		const { service, messages, getDatabaseSchema } = createService(connection);
		vi.spyOn(service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue({
			schema: {
				tables: ['Events'], columnTypesByTable: { Events: { TIMESTAMP: 'datetime' } },
				rawSchemaJson: makeRawSchema('TelemetryDb'),
			},
			timestamp: Date.now() - SCHEMA_CACHE_TTL_MS - 1000,
			version: SCHEMA_CACHE_VERSION,
		});
		getDatabaseSchema.mockRejectedValueOnce(new Error('offline'));

		await service.prefetchSchema('primary', 'TelemetryDb', '__schema_req__manual', false, 'schema-real', {}, {
			sectionInstanceId: 'instance-real', targetGeneration: 2,
		});

		await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: '__schema_req__manual', requestToken: 'schema-real',
			sectionInstanceId: 'instance-real', targetGeneration: 2, isBackgroundRefresh: true,
		})));
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

	it('does not publish schema after the connection target changes during fetch', async () => {
		const harness = createService(connection);
		let resolve!: (value: any) => void;
		harness.getDatabaseSchema.mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise; }));
		vi.spyOn(harness.service as any, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);

		const request = harness.service.prefetchSchema('primary', 'TelemetryDb', 'query_1', false, 'schema-1');
		await vi.waitFor(() => expect(harness.getDatabaseSchema).toHaveBeenCalledOnce());
		harness.setConnection({ ...connection, clusterUrl: 'https://other.kusto.windows.net' });
		resolve({
			schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: makeRawSchema('TelemetryDb') },
			fromCache: false,
			accountPartition: 'test-partition',
		});
		await request;

		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'schemaData' }));
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'schemaError' }));
	});

	it('stops tool schema refresh when the connection target changes during discovery', async () => {
		const harness = createService(connection);
		let resolve!: (databases: string[]) => void;
		harness.getDatabases.mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise; }));

		const request = harness.service.refreshSchemaForTools(connection.clusterUrl, connection.id);
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
		harness.setConnection({ ...connection, clusterUrl: 'https://other.kusto.windows.net' });
		resolve(['TelemetryDb']);

		await expect(request).resolves.toEqual({
			schemas: [],
			error: 'The connection changed while schema refresh was running.',
		});
		expect(harness.getDatabaseSchema).not.toHaveBeenCalled();
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'schemaData' }));
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

	it('terminates schema prefetch for a malformed historical authority', async () => {
		const malformed = { ...connection, authorityId: 'not a tenant' };
		const { service, messages, getDatabaseSchema } = createService(malformed);

		await service.prefetchSchema(malformed.id, 'TelemetryDb', 'query_1', false, 'schema-1');

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_1', requestToken: 'schema-1',
			error: expect.stringContaining('invalid Tenant / Authority ID'),
		}));
		expect(getDatabaseSchema).not.toHaveBeenCalled();
	});

	it('pushes a tool-refreshed schema into matching active editor boxes', async () => {
		const { service, messages, getDatabases } = createService(connection);

		const result = await service.refreshSchemaForTools(connection.clusterUrl, connection.id, [
			{
				boxId: 'query_live', database: 'TelemetryDb',
				sectionInstanceId: 'instance-live', targetGeneration: 8,
			},
		]);

		expect(getDatabases).toHaveBeenCalledWith(connection, true, expect.objectContaining({ source: 'query-editor-tool-schema-refresh' }));
		expect(result.schemas).toContainEqual(expect.objectContaining({ database: 'TelemetryDb', tables: ['Events'] }));
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaData',
			boxId: 'query_live',
			connectionId: 'primary',
			database: 'TelemetryDb',
			accountPartition: 'test-partition',
			sectionInstanceId: 'instance-live',
			targetGeneration: 8,
			schemaMeta: expect.objectContaining({ refreshState: 'completed', workerUpdateNeeded: true }),
		}));
	});

	it('posts a stamped terminal when a tool target database is absent', async () => {
		const { service, messages, getDatabases } = createService(connection);
		getDatabases.mockResolvedValueOnce(['OtherDb']);

		await service.refreshSchemaForTools(connection.clusterUrl, connection.id, [{
			boxId: 'query_live', database: 'MissingDb', requestToken: 'schema-tool-1',
			sectionInstanceId: 'instance-live', targetGeneration: 8,
		}]);

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_live', database: 'MissingDb', requestToken: 'schema-tool-1',
			sectionInstanceId: 'instance-live', targetGeneration: 8, silent: true, refreshState: 'failed',
		}));
	});

	it('posts a stamped terminal when a tool target schema fetch fails', async () => {
		const { service, messages, getDatabaseSchema } = createService(connection);
		getDatabaseSchema.mockRejectedValueOnce(new Error('fetch failed'));

		await service.refreshSchemaForTools(connection.clusterUrl, connection.id, [{
			boxId: 'query_live', database: 'TelemetryDb', requestToken: 'schema-tool-2',
			sectionInstanceId: 'instance-live', targetGeneration: 9,
		}]);

		expect(messages).toContainEqual(expect.objectContaining({
			type: 'schemaError', boxId: 'query_live', database: 'TelemetryDb', requestToken: 'schema-tool-2',
			sectionInstanceId: 'instance-live', targetGeneration: 9, silent: true, refreshState: 'failed',
		}));
	});
});
