import type * as vscode from 'vscode';

import { getKustoConnectionIdentityKey } from '../shared/kustoAuth';
import type { ConnectionManager, KustoConnection } from './connectionManager';
import type { KustoFavorite } from './connectionManagerFavorites';
import { getEditingPreferencesData } from './editingPreferences';
import type { KustoAuthPreferenceService } from './kustoAuthPreferenceService';
import type { KustoQueryClient } from './kustoClient';
import { STORAGE_KEYS } from './queryEditorTypes';
import {
	captureKustoConnectionsProjectionHostMessage,
	type KustoConnectionsData,
} from '../shared/kustoConnectionsProjectionProtocol';

export let testIsolateKustoConnections = false;

export function setTestIsolateKustoConnections(enabled: boolean): void {
	testIsolateKustoConnections = !!enabled;
}

export interface KustoConnectionsProjectionApplicationHandler {
	refresh(policyRequestId?: string): Promise<void>;
	dispose(): void;
}

export type KustoConnectionsProjectionApplicationHandlerOptions = {
	context: Pick<vscode.ExtensionContext, 'globalState'>;
	connectionManager: Pick<ConnectionManager,
		'getConnections'
		| 'getConnectionIncarnation'
		| 'normalizeClusterUrl'
		| 'runWithLeaveNoTraceSnapshotLock'>;
	authPreferences: Pick<KustoAuthPreferenceService,
		'getAccounts'
		| 'getPreferredAccountId'
		| 'getAccountPartition'>;
	kustoClient: Partial<Pick<KustoQueryClient, 'getAccountPartition'>>;
	getLastSelection(): { lastConnectionId?: string; lastDatabase?: string };
	getCachedDatabases(): Record<string, string[]>;
	getFavorites(): KustoFavorite[];
	postMessage(message: KustoConnectionsData): boolean | PromiseLike<boolean> | void;
	postKustoPublication(message: KustoConnectionsData): Promise<boolean>;
};

export class HostKustoConnectionsProjectionApplicationHandler
	implements KustoConnectionsProjectionApplicationHandler {
	private disposed = false;
	private snapshotRevision = 0;
	private snapshotTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: KustoConnectionsProjectionApplicationHandlerOptions) {}

	refresh(policyRequestId?: string): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const revision = ++this.snapshotRevision;
		const publish = () => this.disposed
			? Promise.resolve()
			: this.publishSnapshot(revision, policyRequestId);
		const result = this.snapshotTail.then(publish, publish);
		this.snapshotTail = result.catch(() => undefined);
		return result;
	}

	dispose(): void {
		this.disposed = true;
	}

	private getResolvedAccountPartition(connection: KustoConnection): string | undefined {
		const resolver = this.options.kustoClient.getAccountPartition;
		if (typeof resolver === 'function') {
			return resolver.call(this.options.kustoClient, connection);
		}
		const accountId = this.options.authPreferences.getPreferredAccountId(connection.id);
		return accountId
			? this.options.authPreferences.getAccountPartition(connection.authorityId, accountId)
			: undefined;
	}

	private captureSnapshot(message: KustoConnectionsData): KustoConnectionsData {
		const captured = captureKustoConnectionsProjectionHostMessage(message);
		if (!captured.ok) {
			throw new Error(`Invalid Kusto connections projection: ${captured.error}`);
		}
		if (captured.value.connectionsRevision === undefined) {
			throw new Error('Invalid Kusto connections projection: canonical revision was omitted.');
		}
		return captured.value as KustoConnectionsData;
	}

	private async publishSnapshot(revision: number, policyRequestId?: string): Promise<void> {
		const {
			type: _type,
			revision: editingPreferencesRevision,
			...editingPreferences
		} = getEditingPreferencesData(this.options.context);
		const settings = {
			...editingPreferences,
			editingPreferencesRevision,
			connectionsRevision: revision,
			copilotChatFirstTimeDismissed: !!this.options.context.globalState.get<boolean>(
				STORAGE_KEYS.copilotChatFirstTimeDismissed,
			),
			...(policyRequestId ? { policyRequestId } : {}),
		};

		if (testIsolateKustoConnections) {
			const message: KustoConnectionsData = {
				type: 'connectionsData',
				connections: [],
				accounts: [],
				lastConnectionId: null,
				lastDatabase: null,
				cachedDatabases: {},
				favorites: [],
				...settings,
				leaveNoTraceClusters: [],
				leaveNoTraceGloballyBlocked: false,
				leaveNoTraceRevisions: {},
				devNotesEnabled: true,
			};
			const captured = this.captureSnapshot(message);
			this.options.postMessage(captured);
			return;
		}

		const attempts = policyRequestId ? 2 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const accounts = await this.options.authPreferences.getAccounts();
			if (this.disposed) return;
			const applied = await this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async policy => {
				if (this.disposed) return false;
				const connections = this.options.connectionManager.getConnections().map(connection => {
					let accountPartition: string | undefined;
					try {
						accountPartition = this.getResolvedAccountPartition(connection);
					} catch {
						accountPartition = undefined;
					}
					let connectionIdentityKey: string | undefined;
					try {
						connectionIdentityKey = getKustoConnectionIdentityKey(
							connection.clusterUrl,
							connection.authorityId,
						);
					} catch {
						connectionIdentityKey = undefined;
					}
					return {
						...connection,
						accountPartition,
						connectionRevision: this.options.connectionManager
							.getConnectionIncarnation(connection.id),
						...(connectionIdentityKey ? { connectionIdentityKey } : {}),
					};
				});
				const leaveNoTraceClusters = policy.globallyBlocked
					? [...new Set(connections
						.map(connection => this.options.connectionManager.normalizeClusterUrl(connection.clusterUrl))
						.filter(Boolean))]
					: [...policy.clusterKeys];
				const selection = this.options.getLastSelection();
				if (this.disposed) return false;
				const message: KustoConnectionsData = {
					type: 'connectionsData',
					connections,
					accounts,
					lastConnectionId: selection.lastConnectionId ?? null,
					lastDatabase: selection.lastDatabase ?? null,
					cachedDatabases: this.options.getCachedDatabases(),
					favorites: this.options.getFavorites(),
					...settings,
					leaveNoTraceClusters,
					leaveNoTraceGloballyBlocked: policy.globallyBlocked,
					leaveNoTraceRevisions: policy.revocationGenerations,
					devNotesEnabled: true,
				};
				const captured = this.captureSnapshot(message);
				return this.options.postKustoPublication(captured);
			});
			if (applied || this.disposed) return;
		}
		throw new Error('Kusto policy snapshot was not applied by the webview.');
	}
}