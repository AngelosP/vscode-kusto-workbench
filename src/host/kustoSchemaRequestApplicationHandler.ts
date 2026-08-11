import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SchemaService } from './queryEditorSchema';

type KustoSchemaRequestMessage = Extract<IncomingWebviewMessage, {
	type: 'prefetchSchema' | 'requestCrossClusterSchema';
}>;

type KustoSchemaService = Pick<SchemaService,
	| 'prefetchSchema'
	| 'handleCrossClusterSchemaRequest'>;

export interface KustoSchemaRequestApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type KustoSchemaRequestApplicationHandlerOptions = {
	schema: KustoSchemaService;
};

export class HostKustoSchemaRequestApplicationHandler
	implements KustoSchemaRequestApplicationHandler {
	private disposed = false;

	constructor(private readonly options: KustoSchemaRequestApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'prefetchSchema':
			case 'requestCrossClusterSchema':
				if (this.disposed) return Promise.resolve();
				return this.handleKustoSchemaRequest(message);
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleKustoSchemaRequest(message: KustoSchemaRequestMessage): Promise<void> {
		switch (message.type) {
			case 'prefetchSchema':
				await this.options.schema.prefetchSchema(
					message.connectionId,
					message.database,
					message.boxId,
					!!message.forceRefresh,
					message.requestToken,
					{
						cacheOnly: !!message.cacheOnly,
						silent: !!message.silent,
						reason: message.reason,
					},
					message.sectionInstanceId !== undefined && message.targetGeneration !== undefined
						? {
							sectionInstanceId: message.sectionInstanceId,
							targetGeneration: message.targetGeneration,
						}
						: undefined,
				);
				return;
			case 'requestCrossClusterSchema':
				await this.options.schema.handleCrossClusterSchemaRequest(
					message.clusterName,
					message.database,
					message.boxId,
					message.requestToken,
					message.requestSource,
					message.traceId,
				);
				return;
		}
	}
}
