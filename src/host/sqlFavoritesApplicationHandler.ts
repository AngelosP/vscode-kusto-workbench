import * as vscode from 'vscode';

import {
	getSqlFavoriteKey,
	removeSqlFavorite,
	sanitizeSqlFavorites,
	type SqlFavorite,
} from './connectionManagerFavorites';
import type { SqlConnectionManager } from './sqlConnectionManager';
import { STORAGE_KEYS, type IncomingWebviewMessage } from './queryEditorTypes';
import type { WorkbenchLogger } from './workbenchLogger';

type SqlFavoritesMessage = Extract<IncomingWebviewMessage, {
	type: 'requestAddSqlFavorite' | 'removeSqlFavorite';
}>;

type SqlFavoritesDataResponse = {
	type: 'sqlFavoritesData';
	favorites: SqlFavorite[];
	boxId?: string;
};

export interface SqlFavoritesApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	getFavorites(): SqlFavorite[];
	dispose(): void;
}

export type SqlFavoritesApplicationHandlerOptions = {
	connectionManager: Pick<SqlConnectionManager, 'getConnection'>;
	globalState: Pick<vscode.Memento, 'get' | 'update'>;
	postMessage: (message: SqlFavoritesDataResponse) => PromiseLike<boolean> | void;
	output: Pick<WorkbenchLogger, 'warn'>;
};

export class HostSqlFavoritesApplicationHandler implements SqlFavoritesApplicationHandler {
	private disposed = false;

	constructor(private readonly options: SqlFavoritesApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'requestAddSqlFavorite':
			case 'removeSqlFavorite':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.handleFavoritesMessage(message);
	}

	getFavorites(): SqlFavorite[] {
		return sanitizeSqlFavorites(this.options.globalState.get<unknown>(STORAGE_KEYS.sqlFavorites));
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleFavoritesMessage(message: SqlFavoritesMessage): Promise<void> {
		switch (message.type) {
			case 'requestAddSqlFavorite':
				await this.promptAddSqlFavorite(message);
				return;
			case 'removeSqlFavorite':
				await this.removeSqlFavorite(message.connectionId, message.database);
				return;
		}
	}

	private async promptAddSqlFavorite(
		message: Extract<SqlFavoritesMessage, { type: 'requestAddSqlFavorite' }>,
	): Promise<void> {
		const connectionId = String(message.connectionId || '').trim();
		const database = String(message.database || '').trim();
		if (!connectionId || !database) return;

		const connection = this.options.connectionManager.getConnection(connectionId);
		const serverName = connection
			? (connection.name || connection.serverUrl || connectionId)
			: connectionId;
		const defaultName = String(message.defaultName || '').trim() || `${serverName}.${database}`;
		const picked = await vscode.window.showInputBox({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this server + database',
			value: defaultName,
			ignoreFocusOut: true,
		});
		const name = typeof picked === 'string' ? picked.trim() : '';
		if (!name) return;

		const key = getSqlFavoriteKey(connectionId, database);
		const current = this.getFavorites();
		let replaced = false;
		const favorites = current.map(existing => {
			if (getSqlFavoriteKey(existing.connectionId, existing.database) !== key) return existing;
			replaced = true;
			return { name, connectionId, database };
		});
		if (!replaced) favorites.push({ name, connectionId, database });
		await this.persistAndPublish(favorites, message.boxId);
	}

	private async removeSqlFavorite(connectionIdRaw: string, databaseRaw: string): Promise<void> {
		const connectionId = String(connectionIdRaw || '').trim();
		const database = String(databaseRaw || '').trim();
		if (!connectionId || !database) return;
		const { favorites } = removeSqlFavorite(this.getFavorites(), connectionId, database);
		await this.persistAndPublish(favorites);
	}

	private async persistAndPublish(favorites: SqlFavorite[], boxId?: string): Promise<void> {
		await this.options.globalState.update(STORAGE_KEYS.sqlFavorites, favorites);
		try {
			await Promise.resolve(this.options.postMessage({
				type: 'sqlFavoritesData',
				favorites: this.getFavorites(),
				...(boxId ? { boxId } : {}),
			}));
		} catch (error) {
			try {
				this.options.output.warn(
					`[favorites] Failed to send sqlFavoritesData: ${error instanceof Error ? error.message : String(error)}`,
				);
			} catch {
				// Ignore logging failures.
			}
		}
	}
}
