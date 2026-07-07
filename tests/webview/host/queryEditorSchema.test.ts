import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { SchemaService } from '../../../src/host/queryEditorSchema';
import type { KustoConnection } from '../../../src/host/connectionManager';

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
		kustoClient: { getDatabaseSchema } as any,
		connectionManager: { getConnections: vi.fn(() => [connection]) } as any,
		output: { appendLine: vi.fn() } as any,
		postMessage: (message: unknown) => { messages.push(message); },
		formatQueryExecutionErrorForUser: (error: unknown) => String(error),
		findConnection: vi.fn(),
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

		await service.handleCrossClusterSchemaRequest('semantic-current.westus.kusto.windows.net', 'TelemetryDb', 'query_1', 'token_1');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', false);
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'semantic-current.westus.kusto.windows.net',
			clusterUrl: 'https://semantic-current.westus',
			database: 'TelemetryDb',
			boxId: 'query_1',
			requestToken: 'token_1',
			source: 'fresh',
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

		await service.handleCrossClusterSchemaRequest('semantic-current.westus', 'TelemetryDb', 'query_2', 'token_2');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'TelemetryDb', false);
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'semantic-current.westus',
			clusterUrl: 'https://semantic-current.westus.kusto.windows.net',
			database: 'TelemetryDb',
			boxId: 'query_2',
			requestToken: 'token_2',
		}));
	});
});