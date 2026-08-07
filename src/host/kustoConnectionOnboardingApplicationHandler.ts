import { normalizeKustoAuthorityId } from '../shared/kustoAuth';
import type { ConnectionManager, KustoConnection } from './connectionManager';
import {
	createDatabaseListTraceId,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from './databaseListTrace';
import type { KustoAccountPreference, KustoAuthPreferenceService } from './kustoAuthPreferenceService';
import type { KustoQueryClient } from './kustoClient';
import { ensureHttpsUrl } from './queryEditorConnection';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { WorkbenchLogger } from './workbenchLogger';

type KustoConnectionOnboardingMessage = Extract<IncomingWebviewMessage, {
	type: 'promptAddConnection' | 'addConnection' | 'testKustoConnection';
}>;

type KustoConnectionOnboardingResponse =
	| { type: 'openKustoAddConnectionDialog'; boxId?: string }
	| { type: 'kustoConnectionMutationResult'; boxId?: string; success: false; message: string }
	| { type: 'connectionAdded'; boxId?: string; connectionId: string; lastConnectionId?: string; lastDatabase?: string }
	| { type: 'kustoConnectionTestStarted'; boxId?: string }
	| {
		type: 'kustoConnectionTestResult';
		boxId?: string;
		success: boolean;
		message: string;
		databases?: string[];
		warning?: true;
		isAuthError?: boolean;
	};

type KustoConnectionTestClient = Pick<KustoQueryClient, 'getDatabases' | 'isAuthenticationError'> & {
	withTransientAuthPreference?<T>(
		connection: KustoConnection,
		preference: KustoAccountPreference,
		operation: () => Promise<T>,
	): Promise<T>;
};

export interface KustoConnectionOnboardingApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type KustoConnectionOnboardingApplicationHandlerOptions = {
	connectionManager: Pick<ConnectionManager, 'addConnection'>;
	authPreferences: Pick<KustoAuthPreferenceService, 'getAccounts' | 'setExplicitAccount'>;
	kustoClient: KustoConnectionTestClient;
	saveLastSelection: (connectionId: string, database?: string) => Promise<void>;
	getLastSelection: () => { lastConnectionId?: string; lastDatabase?: string };
	postMessage: (message: KustoConnectionOnboardingResponse) => PromiseLike<boolean> | void;
	refreshConnections: () => Promise<void>;
	output: WorkbenchLogger;
};

export class HostKustoConnectionOnboardingApplicationHandler implements KustoConnectionOnboardingApplicationHandler {
	private disposed = false;

	constructor(private readonly options: KustoConnectionOnboardingApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'promptAddConnection':
			case 'addConnection':
			case 'testKustoConnection':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.handleOnboardingMessage(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private traceDatabaseList(traceId: string, event: string, details: Record<string, unknown> = {}): void {
		traceDatabaseList(this.options.output, traceId, 'service', event, details);
	}

	private async handleOnboardingMessage(message: KustoConnectionOnboardingMessage): Promise<void> {
		switch (message.type) {
			case 'promptAddConnection':
				this.options.postMessage({ type: 'openKustoAddConnectionDialog', boxId: message.boxId });
				return;
			case 'addConnection':
				await this.addConnectionFromWebview(message);
				return;
			case 'testKustoConnection':
				await this.testConnectionFromWebview(message);
				return;
		}
	}

	private async addConnectionFromWebview(
		data: Extract<KustoConnectionOnboardingMessage, { type: 'addConnection' }>,
	): Promise<void> {
		let clusterUrl = String(data.clusterUrl || '').trim();
		if (!clusterUrl) return;
		clusterUrl = ensureHttpsUrl(clusterUrl);

		const name = String(data.name || '').trim() || clusterUrl;
		const database = String(data.database || '').trim() || undefined;
		const accountId = String(data.accountId || '').trim();
		let authorityId: string | undefined;
		try {
			authorityId = normalizeKustoAuthorityId(data.authorityId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.postMessage({ type: 'kustoConnectionMutationResult', boxId: data.boxId, success: false, message });
			return;
		}

		try {
			const newConnection = await this.options.connectionManager.addConnection({ name, clusterUrl, database, authorityId });
			if (accountId) {
				const account = (await this.options.authPreferences.getAccounts()).find(candidate => candidate.id === accountId)
					?? { id: accountId, label: accountId };
				await this.options.authPreferences.setExplicitAccount(newConnection.id, account);
			}
			await this.options.saveLastSelection(newConnection.id, newConnection.database);
			await this.options.refreshConnections();
			const selection = this.options.getLastSelection();

			this.options.postMessage({
				type: 'connectionAdded',
				boxId: data.boxId,
				connectionId: newConnection.id,
				lastConnectionId: selection.lastConnectionId,
				lastDatabase: selection.lastDatabase,
			});
		} catch (error) {
			this.options.postMessage({
				type: 'kustoConnectionMutationResult',
				boxId: data.boxId,
				success: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async testConnectionFromWebview(
		data: Extract<KustoConnectionOnboardingMessage, { type: 'testKustoConnection' }>,
	): Promise<void> {
		const traceId = createDatabaseListTraceId();
		let clusterUrl = String(data.clusterUrl || '').trim();
		if (!clusterUrl) {
			this.traceDatabaseList(traceId, 'test.invalid-request', { reason: 'missing-cluster-url' });
			this.options.postMessage({ type: 'kustoConnectionTestResult', boxId: data.boxId, success: false, message: 'Enter a cluster URL before testing.' });
			return;
		}
		clusterUrl = ensureHttpsUrl(clusterUrl);

		let connection: KustoConnection;
		try {
			connection = {
				id: `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`,
				name: String(data.name || '').trim() || clusterUrl,
				clusterUrl,
				database: String(data.database || '').trim() || undefined,
				authorityId: normalizeKustoAuthorityId(data.authorityId),
			};
		} catch (error) {
			this.options.postMessage({ type: 'kustoConnectionTestResult', boxId: data.boxId, success: false, message: error instanceof Error ? error.message : String(error) });
			return;
		}

		this.traceDatabaseList(traceId, 'test.start', { connectionId: connection.id, boxId: data.boxId });
		this.options.postMessage({ type: 'kustoConnectionTestStarted', boxId: data.boxId });
		try {
			const accountId = String(data.accountId || '').trim();
			const preference: KustoAccountPreference = accountId ? { mode: 'explicit', accountId } : { mode: 'automatic' };
			const operation = () => this.options.kustoClient.getDatabases(connection, true, {
				allowInteractive: true,
				traceId,
				source: 'query-editor-connection-test',
				persistIdentity: false,
			});
			const transient = this.options.kustoClient.withTransientAuthPreference;
			const databases = typeof transient === 'function'
				? await transient.call(this.options.kustoClient, connection, preference, operation)
				: await operation();
			const databaseList = (Array.isArray(databases) ? databases : [])
				.map(database => String(database || '').trim())
				.filter(Boolean);
			this.traceDatabaseList(traceId, 'test.success', { connectionId: connection.id, databaseCount: databaseList.length });
			this.options.postMessage(databaseList.length === 0 ? {
				type: 'kustoConnectionTestResult',
				boxId: data.boxId,
				success: false,
				warning: true,
				message: 'Connected, but no databases are visible. Check the Authority / Tenant ID and account.',
				databases: databaseList,
			} : {
				type: 'kustoConnectionTestResult',
				boxId: data.boxId,
				success: true,
				message: `Connected successfully! Found ${databaseList.length} database(s).`,
				databases: databaseList,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isAuthError = this.options.kustoClient.isAuthenticationError(error);
			this.traceDatabaseList(traceId, 'test.failed', {
				connectionId: connection.id,
				boxId: data.boxId,
				isAuthError,
				...getDatabaseListErrorDetails(error),
			});
			this.options.postMessage({
				type: 'kustoConnectionTestResult',
				boxId: data.boxId,
				success: false,
				message: isAuthError ? 'Authentication failed. Please sign in when prompted.' : `Connection failed: ${errorMessage}`,
				isAuthError,
			});
		}
	}
}