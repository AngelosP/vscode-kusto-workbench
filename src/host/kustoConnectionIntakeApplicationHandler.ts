import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import type { ConnectionManager } from './connectionManager';
import {
	ensureHttpsUrl,
	getClusterShortNameKey,
	getDefaultConnectionName,
} from './queryEditorConnection';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type KustoConnectionIntakeMessage = Extract<IncomingWebviewMessage, {
	type: 'addConnectionsForClusters' | 'promptImportConnectionsXml' | 'importConnectionsFromXml';
}>;

type KustoConnectionIntakeResponse =
	| { type: 'importConnectionsXmlText'; boxId?: string; text: string; fileName: string }
	| { type: 'importConnectionsXmlError'; boxId?: string; error: string };

export interface KustoConnectionIntakeApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type KustoConnectionIntakeApplicationHandlerOptions = {
	connectionManager: Pick<ConnectionManager, 'getConnections' | 'addConnection'>;
	postMessage: (message: KustoConnectionIntakeResponse) => PromiseLike<boolean> | void;
	refreshConnections: () => Promise<void>;
};

export class HostKustoConnectionIntakeApplicationHandler implements KustoConnectionIntakeApplicationHandler {
	private disposed = false;

	constructor(private readonly options: KustoConnectionIntakeApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'addConnectionsForClusters':
			case 'promptImportConnectionsXml':
			case 'importConnectionsFromXml':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.handleIntakeMessage(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleIntakeMessage(message: KustoConnectionIntakeMessage): Promise<void> {
		switch (message.type) {
			case 'addConnectionsForClusters':
				await this.addConnectionsForClusters(message.clusterUrls);
				await this.options.refreshConnections();
				return;
			case 'promptImportConnectionsXml':
				await this.promptImportConnectionsXml(message.boxId);
				return;
			case 'importConnectionsFromXml':
				await this.importConnectionsFromXml(message.connections);
				await this.options.refreshConnections();
				return;
		}
	}

	private async addConnectionsForClusters(clusterUrls: string[]): Promise<void> {
		const urls = Array.isArray(clusterUrls) ? clusterUrls : [];
		if (!urls.length) {
			return;
		}

		const existing = this.options.connectionManager.getConnections();
		const existingKeys = new Set(existing.map((connection) => getClusterShortNameKey(connection.clusterUrl || '')).filter(Boolean));

		for (const url of urls) {
			const original = String(url || '').trim();
			if (!original) {
				continue;
			}
			const key = getClusterShortNameKey(original);
			if (!key || existingKeys.has(key)) {
				continue;
			}
			const clusterUrl = ensureHttpsUrl(original);
			await this.options.connectionManager.addConnection({
				name: getDefaultConnectionName(clusterUrl),
				clusterUrl,
				database: undefined,
			});
			existingKeys.add(key);
		}
	}

	private async importConnectionsFromXml(
		connections: Array<{ name: string; clusterUrl: string; database?: string; authorityId?: string }>,
	): Promise<void> {
		const incoming = Array.isArray(connections) ? connections : [];
		if (!incoming.length) {
			return;
		}

		const existing = this.options.connectionManager.getConnections();
		const existingIdentities = new Set(existing.flatMap((connection) => {
			try {
				const key = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
				return key ? [key] : [];
			} catch {
				return [];
			}
		}));

		let added = 0;
		for (const connection of incoming) {
			try {
				const name = String(connection?.name || '').trim();
				const clusterUrlRaw = String(connection?.clusterUrl || '').trim();
				const database = connection?.database ? String(connection.database).trim() : undefined;
				const authorityId = normalizeKustoAuthorityId(connection?.authorityId);
				if (!clusterUrlRaw) continue;
				const clusterUrl = ensureHttpsUrl(clusterUrlRaw).replace(/\/+$/g, '');
				const key = getKustoConnectionIdentityKey(clusterUrl, authorityId);
				if (existingIdentities.has(key)) continue;
				await this.options.connectionManager.addConnection({ name: name || clusterUrl, clusterUrl, database, authorityId });
				existingIdentities.add(key);
				added++;
			} catch {
				// Skip malformed imported identities without blocking later valid entries.
			}
		}

		if (added > 0) {
			void vscode.window.showInformationMessage(`Imported ${added} Kusto connection${added === 1 ? '' : 's'}.`);
		} else {
			void vscode.window.showInformationMessage('No new connections were imported (they may already exist).');
		}
	}

	private async promptImportConnectionsXml(boxId?: string): Promise<void> {
		try {
			const localAppData = process.env.LOCALAPPDATA;
			const base = localAppData && localAppData.trim()
				? localAppData.trim()
				: path.join(os.homedir(), 'AppData', 'Local');
			const defaultFolder = path.join(base, 'Kusto.Explorer');
			const defaultUri = vscode.Uri.file(defaultFolder);

			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri,
				openLabel: 'Import',
				filters: {
					'XML files': ['xml'],
					'All files': ['*'],
				},
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const uri = picked[0];
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8').decode(bytes);
			this.options.postMessage({
				type: 'importConnectionsXmlText',
				boxId,
				text,
				fileName: path.basename(uri.fsPath),
			});
		} catch (error: unknown) {
			const candidate = error as { message?: unknown } | null | undefined;
			const errorMessage = typeof candidate?.message === 'string' ? candidate.message : String(error);
			this.options.postMessage({ type: 'importConnectionsXmlError', boxId, error: errorMessage });
		}
	}
}