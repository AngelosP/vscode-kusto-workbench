import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SchemaService } from '../../../src/host/queryEditorSchema';
import type { KustoConnection } from '../../../src/host/connectionManager';

function makeRawSchema(database: string) {
	return {
		Plugins: [],
		Databases: {
			[database]: {
				Tables: {
					bizops: {
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
	const rawSchemaJson = makeRawSchema('prod');
	const getDatabaseSchema = vi.fn(async () => ({
		schema: {
			tables: ['bizops'],
			columnTypesByTable: { bizops: { TIMESTAMP: 'datetime', EventName: 'string' } },
			rawSchemaJson,
		},
		fromCache: false,
	}));
	const service = new SchemaService({
		context: {
			globalStorageUri: vscode.Uri.file('/tmp/kusto-workbench-query-editor-schema-test'),
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
			id: 'aoai-westus',
			name: 'AOAI Agents West US',
			clusterUrl: 'https://aoaiagents1.westus',
		};
		const { service, messages, getDatabaseSchema } = createService(connection);

		await service.handleCrossClusterSchemaRequest('aoaiagents1.westus.kusto.windows.net', 'prod', 'query_1', 'token_1');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'prod', false);
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'aoaiagents1.westus.kusto.windows.net',
			clusterUrl: 'https://aoaiagents1.westus',
			database: 'prod',
			boxId: 'query_1',
			requestToken: 'token_1',
			source: 'fresh',
			rawSchemaJson: makeRawSchema('prod'),
		}));
		expect(messages).not.toContainEqual(expect.objectContaining({ type: 'crossClusterSchemaError' }));
	});

	it('matches a regional short-form request to a full ADX host configured connection', async () => {
		const connection: KustoConnection = {
			id: 'aoai-westus-full',
			name: 'AOAI Agents West US Full',
			clusterUrl: 'https://aoaiagents1.westus.kusto.windows.net',
		};
		const { service, messages, getDatabaseSchema } = createService(connection);

		await service.handleCrossClusterSchemaRequest('aoaiagents1.westus', 'prod', 'query_2', 'token_2');

		expect(getDatabaseSchema).toHaveBeenCalledWith(connection, 'prod', false);
		expect(messages).toContainEqual(expect.objectContaining({
			type: 'crossClusterSchemaData',
			clusterName: 'aoaiagents1.westus',
			clusterUrl: 'https://aoaiagents1.westus.kusto.windows.net',
			database: 'prod',
			boxId: 'query_2',
			requestToken: 'token_2',
		}));
	});
});