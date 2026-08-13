import type { KustoEditorLifecycleIdentity } from '../shared/kustoSchemaLifecycle';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import {
	isKustoDatabaseDiscoveryWebviewMessageType,
	parseKustoDatabaseDiscoveryWebviewMessage,
	type KustoDatabaseDiscoveryWebviewMessage,
} from '../shared/kustoDatabaseDiscoveryProtocol';
import {
	admitKustoConnectionsProjectionWebviewMessage,
	type KustoConnectionsProjectionRequest,
} from '../shared/kustoConnectionsProjectionProtocol';

type SaveLastSelectionMessage = Extract<IncomingWebviewMessage, {
	type: 'saveLastSelection';
}>;

type DatabaseDiscoveryRequest = {
	mode: 'passive' | 'interactive-refresh';
	requestToken?: string;
	requiredDatabase?: string;
} & Partial<KustoEditorLifecycleIdentity>;

export interface KustoConnectionBrowsingApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type KustoConnectionBrowsingApplicationHandlerOptions = {
	sendConnectionsData(policyRequestId?: string): Promise<void>;
	sendDatabases(connectionId: string, boxId: string, request: DatabaseDiscoveryRequest): Promise<void>;
	saveLastSelection(connectionId: string, database?: string): Promise<void>;
	refreshTextEditorDiagnostics(): PromiseLike<unknown> | unknown;
};

export class HostKustoConnectionBrowsingApplicationHandler
	implements KustoConnectionBrowsingApplicationHandler {
	private disposed = false;

	constructor(private readonly options: KustoConnectionBrowsingApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const connectionsAdmission = admitKustoConnectionsProjectionWebviewMessage(message);
		if (connectionsAdmission.recognized) {
			if (!connectionsAdmission.parsed.ok || this.disposed) return Promise.resolve();
			return this.getConnections(connectionsAdmission.parsed.value);
		}
		if (isKustoDatabaseDiscoveryWebviewMessageType(message)) {
			const parsed = parseKustoDatabaseDiscoveryWebviewMessage(message);
			if (!parsed.ok || this.disposed) return Promise.resolve();
			return this.getDatabases(
				parsed.value,
				parsed.value.type === 'getDatabases' ? 'passive' : 'interactive-refresh',
			);
		}
		switch (message.type) {
			case 'saveLastSelection':
				if (this.disposed) return Promise.resolve();
				return this.saveLastSelection(message);
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private async getConnections(message: KustoConnectionsProjectionRequest): Promise<void> {
		await this.options.sendConnectionsData(message.policyRequestId);
	}

	private async getDatabases(
		message: KustoDatabaseDiscoveryWebviewMessage,
		mode: DatabaseDiscoveryRequest['mode'],
	): Promise<void> {
		await this.options.sendDatabases(message.connectionId, message.boxId, {
			mode,
			requestToken: message.requestToken,
			requiredDatabase: message.requiredDatabase,
			sectionInstanceId: message.sectionInstanceId,
			targetGeneration: message.targetGeneration,
		});
	}

	private async saveLastSelection(message: SaveLastSelectionMessage): Promise<void> {
		const connectionId = String(message.connectionId || '').trim();
		if (!connectionId) return;

		await this.options.saveLastSelection(connectionId, message.database);
		try {
			await this.options.refreshTextEditorDiagnostics();
		} catch {
			// Diagnostics refresh is best-effort after the selection is durable.
		}
	}
}
