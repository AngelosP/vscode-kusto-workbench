import * as vscode from 'vscode';

import type { ConnectionManager, KustoConnection } from './connectionManager';
import {
	filterKustoFavoritesForActivePrincipals,
	getKustoFavoriteKey,
	mergeKustoFavoritesForActivePrincipals,
	migrateKustoFavoritesWithStatus,
	removeKustoFavorite,
	type KustoFavorite,
} from './connectionManagerFavorites';
import type { KustoAuthPreferenceService } from './kustoAuthPreferenceService';
import type { KustoQueryClient } from './kustoClient';
import { STORAGE_KEYS, type IncomingWebviewMessage } from './queryEditorTypes';
import { getWorkbenchLogger, type WorkbenchLogger } from './workbenchLogger';

type KustoFavoritesMessage = Extract<IncomingWebviewMessage, {
	type: 'requestAddFavorite' | 'removeFavorite' | 'confirmRemoveFavorite';
}>;

type KustoFavoritesDataResponse = {
	type: 'favoritesData';
	favorites: KustoFavorite[];
	boxId?: string;
};

type ConfirmRemoveFavoriteResponse = {
	type: 'confirmRemoveFavoriteResult';
	requestId: string;
	ok: boolean;
	connectionId: string;
	clusterUrl: string;
	database: string;
	boxId?: string;
};

export interface KustoFavoritesApplicationHandler {
	activate(): void;
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	getFavorites(): KustoFavorite[];
	dispose(): void;
}

export type KustoFavoritesApplicationHandlerOptions = {
	context: vscode.ExtensionContext;
	connectionManager: Pick<ConnectionManager, 'getConnections'>;
	kustoClient: Partial<Pick<KustoQueryClient, 'getAccountPartition'>>;
	authPreferences: Pick<KustoAuthPreferenceService, 'getPreferredAccountId' | 'getAccountPartition'>;
	postMessage: (message: KustoFavoritesDataResponse | ConfirmRemoveFavoriteResponse) => PromiseLike<boolean> | void;
	output: Pick<WorkbenchLogger, 'warn'>;
};

export function normalizeFavoriteClusterUrl(clusterUrl: string): string {
	const raw = String(clusterUrl || '').trim();
	const normalized = !raw || /^https?:\/\//i.test(raw)
		? raw
		: `https://${raw.replace(/^\/+/, '')}`;
	return normalized.replace(/\/+$/g, '');
}

function getFavoriteDefaultName(clusterUrl: string, database: string): string {
	try {
		const parsed = new URL(normalizeFavoriteClusterUrl(clusterUrl));
		const host = String(parsed.hostname || '').trim();
		return `${host ? (host.split('.')[0] || host) : clusterUrl}.${database}`;
	} catch {
		return `${String(clusterUrl || '').trim() || 'Kusto Cluster'}.${database}`;
	}
}

export class HostKustoFavoritesApplicationHandler implements KustoFavoritesApplicationHandler {
	private static readonly liveHandlers = new Set<HostKustoFavoritesApplicationHandler>();
	private static readonly listeners = new Set<(context: vscode.ExtensionContext) => void | PromiseLike<void>>();

	private disposed = false;

	constructor(private readonly options: KustoFavoritesApplicationHandlerOptions) {
		this.activate();
	}

	static broadcastKustoFavoritesData(
		context: vscode.ExtensionContext,
		originatingBoxId?: string,
		originatingHandler?: HostKustoFavoritesApplicationHandler,
	): void {
		for (const handler of HostKustoFavoritesApplicationHandler.liveHandlers) {
			if (handler.disposed) {
				HostKustoFavoritesApplicationHandler.liveHandlers.delete(handler);
				continue;
			}
			if (!handler.sharesFavoriteStorageWithContext(context)) continue;
			void handler
				.sendFavoritesData(handler === originatingHandler ? originatingBoxId : undefined)
				.catch((error: unknown) => handler.logFavoritesBroadcastError(error));
		}
		for (const listener of HostKustoFavoritesApplicationHandler.listeners) {
			try {
				void Promise.resolve(listener(context)).catch((error: unknown) => {
					try {
						getWorkbenchLogger().warn('[favorites] Failed to notify Kusto favorites listener', error);
					} catch {
						// Ignore logging failures.
					}
				});
			} catch (error) {
				try {
					getWorkbenchLogger().warn('[favorites] Failed to notify Kusto favorites listener', error);
				} catch {
					// Ignore logging failures.
				}
			}
		}
	}

	static onKustoFavoritesChanged(
		listener: (context: vscode.ExtensionContext) => void | PromiseLike<void>,
	): vscode.Disposable {
		HostKustoFavoritesApplicationHandler.listeners.add(listener);
		return {
			dispose: () => {
				HostKustoFavoritesApplicationHandler.listeners.delete(listener);
			},
		};
	}

	activate(): void {
		this.disposed = false;
		HostKustoFavoritesApplicationHandler.liveHandlers.add(this);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'requestAddFavorite':
			case 'removeFavorite':
			case 'confirmRemoveFavorite':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.handleFavoritesMessage(message);
	}

	getFavorites(): KustoFavorite[] {
		const raw = this.options.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const connections = this.options.connectionManager.getConnections();
		const { partitions, failedConnectionIds } = this.getFavoriteAccountPartitions(connections);
		const { favorites, unresolved } = migrateKustoFavoritesWithStatus(raw, connections, partitions);
		if (unresolved === 0 && failedConnectionIds.size === 0
			&& JSON.stringify(raw ?? []) !== JSON.stringify(favorites)) {
			void this.options.context.globalState.update(STORAGE_KEYS.favorites, favorites);
		}
		return filterKustoFavoritesForActivePrincipals(favorites, partitions)
			.filter(favorite => !failedConnectionIds.has(favorite.connectionId));
	}

	dispose(): void {
		this.disposed = true;
		HostKustoFavoritesApplicationHandler.liveHandlers.delete(this);
	}

	private async handleFavoritesMessage(message: KustoFavoritesMessage): Promise<void> {
		switch (message.type) {
			case 'requestAddFavorite':
				await this.promptAddFavorite(message);
				return;
			case 'removeFavorite':
				await this.removeFavorite(message.connectionId, message.database);
				return;
			case 'confirmRemoveFavorite':
				await this.confirmRemoveFavorite(message);
				return;
		}
	}

	private getResolvedAccountPartition(connection: KustoConnection): string | undefined {
		const resolver = this.options.kustoClient.getAccountPartition;
		if (typeof resolver === 'function') return resolver.call(this.options.kustoClient, connection);
		const accountId = this.options.authPreferences.getPreferredAccountId(connection.id);
		return accountId
			? this.options.authPreferences.getAccountPartition(connection.authorityId, accountId)
			: undefined;
	}

	private getFavoriteAccountPartitions(
		connections: readonly KustoConnection[] = this.options.connectionManager.getConnections(),
	): {
		partitions: Map<string, string | undefined>;
		failedConnectionIds: Set<string>;
	} {
		const partitions = new Map<string, string | undefined>();
		const failedConnectionIds = new Set<string>();
		for (const connection of connections) {
			try {
				partitions.set(connection.id, this.getResolvedAccountPartition(connection));
			} catch {
				failedConnectionIds.add(connection.id);
			}
		}
		return { partitions, failedConnectionIds };
	}

	private findConnection(connectionId: string): KustoConnection | undefined {
		return this.options.connectionManager.getConnections().find(connection => connection.id === connectionId);
	}

	private async promptAddFavorite(
		message: Extract<KustoFavoritesMessage, { type: 'requestAddFavorite' }>,
	): Promise<void> {
		const clusterUrlRaw = String(message.clusterUrl || '').trim();
		const connectionId = String(message.connectionId || '').trim();
		const database = String(message.database || '').trim();
		if (!connectionId || !clusterUrlRaw || !database) return;

		const clusterUrl = normalizeFavoriteClusterUrl(clusterUrlRaw);
		const connection = this.findConnection(connectionId);
		const startingPartitions = connection
			? this.getFavoriteAccountPartitions([connection])
			: undefined;
		if (connection && startingPartitions?.failedConnectionIds.has(connection.id)) return;
		const startingAccountPartition = connection
			? startingPartitions?.partitions.get(connection.id)
			: undefined;
		const defaultName = String(message.defaultName || '').trim()
			|| getFavoriteDefaultName(clusterUrl, database);
		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this cluster + database',
			value: defaultName,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;

		const currentConnection = this.findConnection(connectionId);
		const currentPartitions = currentConnection
			? this.getFavoriteAccountPartitions([currentConnection])
			: undefined;
		if (!connection || !currentConnection
			|| currentPartitions?.failedConnectionIds.has(connectionId)
			|| currentPartitions?.partitions.get(connectionId) !== startingAccountPartition) return;
		await this.addOrUpdateFavorite(
			{ name, connectionId, clusterUrl, database },
			message.boxId,
			startingAccountPartition,
		);
	}

	private async addOrUpdateFavorite(
		favorite: KustoFavorite,
		boxId?: string,
		accountPartition?: string,
	): Promise<void> {
		const name = String(favorite.name || '').trim();
		const connectionId = String(favorite.connectionId || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(favorite.clusterUrl || '').trim());
		const database = String(favorite.database || '').trim();
		if (!name || !connectionId || !clusterUrl || !database) return;

		const key = getKustoFavoriteKey(connectionId, database);
		const next: KustoFavorite[] = [];
		let replaced = false;
		for (const existing of this.getFavorites()) {
			if (getKustoFavoriteKey(existing.connectionId, existing.database) === key) {
				next.push({
					name,
					connectionId,
					clusterUrl,
					database,
					...(accountPartition ? { accountPartition } : {}),
				});
				replaced = true;
			} else {
				next.push(existing);
			}
		}
		if (!replaced) {
			next.push({
				name,
				connectionId,
				clusterUrl,
				database,
				...(accountPartition ? { accountPartition } : {}),
			});
		}
		await this.setFavorites(next, boxId, { connectionId, accountPartition });
	}

	private async removeFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) return;
		const { favorites } = removeKustoFavorite(this.getFavorites(), connectionId, database);
		await this.setFavorites(favorites);
	}

	private async setFavorites(
		favorites: KustoFavorite[],
		boxId?: string,
		expectedOwner?: { connectionId: string; accountPartition?: string },
	): Promise<void> {
		const raw = this.options.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		const connections = this.options.connectionManager.getConnections();
		const { partitions } = this.getFavoriteAccountPartitions(connections);
		if (expectedOwner && (!partitions.has(expectedOwner.connectionId)
			|| partitions.get(expectedOwner.connectionId) !== expectedOwner.accountPartition)) return;
		const migration = migrateKustoFavoritesWithStatus(raw, connections, partitions);
		if (migration.unresolved > 0) return;
		await this.options.context.globalState.update(
			STORAGE_KEYS.favorites,
			mergeKustoFavoritesForActivePrincipals(migration.favorites, favorites, partitions),
		);
		HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(this.options.context, boxId, this);
	}

	private async confirmRemoveFavorite(
		message: Extract<KustoFavoritesMessage, { type: 'confirmRemoveFavorite' }>,
	): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const clusterUrl = normalizeFavoriteClusterUrl(String(message.clusterUrl || '').trim());
		const connectionId = String(message.connectionId || '').trim();
		const database = String(message.database || '').trim();
		const label = String(message.label || '').trim();
		if (!requestId) return;

		let ok = false;
		try {
			const display = label || (clusterUrl && database ? `${clusterUrl} (${database})` : 'this favorite');
			const choice = await vscode.window.showWarningMessage(
				`Remove "${display}" from favorites?`,
				{ modal: true },
				'Remove',
			);
			ok = choice === 'Remove';
		} catch {
			ok = false;
		}

		this.options.postMessage({
			type: 'confirmRemoveFavoriteResult',
			requestId,
			ok,
			connectionId,
			clusterUrl,
			database,
			boxId: message.boxId,
		});
	}

	private sharesFavoriteStorageWithContext(
		context: vscode.ExtensionContext,
	): boolean {
		if (this.options.context === context) return true;
		try {
			return this.options.context.globalState.get<unknown>(STORAGE_KEYS.favorites)
				=== context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		} catch {
			return false;
		}
	}

	private async sendFavoritesData(boxId?: string): Promise<void> {
		await Promise.resolve(this.options.postMessage({
			type: 'favoritesData',
			favorites: this.getFavorites(),
			...(boxId ? { boxId } : {}),
		}));
	}

	private logFavoritesBroadcastError(error: unknown): void {
		try {
			this.options.output.warn(
				`[favorites] Failed to broadcast favoritesData: ${error instanceof Error ? error.message : String(error)}`,
			);
		} catch {
			// Ignore logging failures.
		}
	}
}