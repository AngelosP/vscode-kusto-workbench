import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, DatabaseSchemaIndex } from './kustoClient';

const VIEW_TITLE = 'Kusto Workbench: Connection Manager';

const STORAGE_KEYS = {
	favorites: 'kusto.favorites',
	expandedClusters: 'kusto.connectionManager.expandedClusters',
	cachedDatabases: 'kusto.cachedDatabases'
} as const;

// Same type as used in queryEditorProvider.ts
export type KustoFavorite = {
	name: string;
	clusterUrl: string;
	database: string;
};

type ClusterExplorerNode = {
	type: 'cluster' | 'database' | 'folder' | 'table' | 'function' | 'view';
	name: string;
	connectionId?: string;
	database?: string;
	folder?: string;
	docString?: string;
	columns?: Array<{ name: string; type: string }>;
};

type Snapshot = {
	timestamp: number;
	connections: KustoConnection[];
	favorites: KustoFavorite[];
	cachedDatabases: Record<string, string[]>;
	expandedClusters: string[];
};

type IncomingMessage =
	| { type: 'requestSnapshot' }
	| { type: 'connection.add'; name: string; clusterUrl: string; database?: string }
	| { type: 'connection.edit'; id: string; name: string; clusterUrl: string; database?: string }
	| { type: 'connection.delete'; id: string }
	| { type: 'connection.test'; id: string }
	| { type: 'connection.duplicate'; id: string }
	| { type: 'favorite.add'; clusterUrl: string; database: string; name: string }
	| { type: 'favorite.remove'; clusterUrl: string; database: string }
	| { type: 'favorite.reorder'; favorites: KustoFavorite[] }
	| { type: 'cluster.expand'; connectionId: string }
	| { type: 'cluster.collapse'; connectionId: string }
	| { type: 'cluster.refreshDatabases'; connectionId: string }
	| { type: 'database.getSchema'; connectionId: string; database: string }
	| { type: 'copyToClipboard'; text: string }
	| { type: 'openInEditor'; connectionId: string; database?: string };

export class ConnectionManagerViewer {
	private static current: ConnectionManagerViewer | undefined;

	public static open(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		connectionManager: ConnectionManager
	): void {
		if (ConnectionManagerViewer.current) {
			ConnectionManagerViewer.current.panel.webview.html = ConnectionManagerViewer.current.buildHtml(
				ConnectionManagerViewer.current.panel.webview
			);
			ConnectionManagerViewer.current.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		ConnectionManagerViewer.current = new ConnectionManagerViewer(context, extensionUri, connectionManager);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly kustoClient: KustoQueryClient;
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {
		this.kustoClient = new KustoQueryClient(this.context);
		this.panel = vscode.window.createWebviewPanel(
			'kusto.connectionManager',
			VIEW_TITLE,
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri]
			}
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage((msg: IncomingMessage) => void this.onMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml(this.panel.webview);
	}

	private dispose(): void {
		ConnectionManagerViewer.current = undefined;
		for (const d of this.disposables) {
			try {
				d.dispose();
			} catch {
				/* ignore */
			}
		}
	}

	private getFavorites(): KustoFavorite[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.favorites);
		if (!Array.isArray(raw)) {
			return [];
		}
		const out: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (!name || !clusterUrl || !database) {
				continue;
			}
			out.push({ name, clusterUrl, database });
		}
		return out;
	}

	private async setFavorites(favorites: KustoFavorite[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.favorites, favorites);
	}

	private normalizeFavoriteClusterUrl(clusterUrl: string): string {
		let u = String(clusterUrl || '').trim();
		if (!u) {
			return '';
		}
		if (!/^https?:\/\//i.test(u)) {
			u = 'https://' + u;
		}
		return u.replace(/\/+$/g, '').toLowerCase();
	}

	private isFavorite(clusterUrl: string, database: string): boolean {
		const normalizedUrl = this.normalizeFavoriteClusterUrl(clusterUrl);
		const normalizedDb = String(database || '').trim().toLowerCase();
		const favorites = this.getFavorites();
		return favorites.some((f) => {
			const fUrl = this.normalizeFavoriteClusterUrl(f.clusterUrl);
			const fDb = String(f.database || '').trim().toLowerCase();
			return fUrl === normalizedUrl && fDb === normalizedDb;
		});
	}

	private getExpandedClusters(): string[] {
		const raw = this.context.globalState.get<string[] | undefined>(STORAGE_KEYS.expandedClusters);
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	}

	private async setExpandedClusters(expanded: string[]): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.expandedClusters, expanded);
	}

	private getCachedDatabases(): Record<string, string[]> {
		const raw = this.context.globalState.get<Record<string, string[]> | undefined>(STORAGE_KEYS.cachedDatabases);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}
		const result: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof k === 'string' && Array.isArray(v)) {
				result[k] = v.filter((d) => typeof d === 'string');
			}
		}
		return result;
	}

	private async setCachedDatabases(cached: Record<string, string[]>): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
	}

	private getClusterCacheKey(clusterUrlRaw: string): string {
		try {
			let u = String(clusterUrlRaw || '').trim();
			if (!u) {
				return '';
			}
			if (!/^https?:\/\//i.test(u)) {
				u = 'https://' + u;
			}
			const parsed = new URL(u);
			const host = String(parsed.hostname || '').trim().toLowerCase();
			return host || String(clusterUrlRaw || '').trim().toLowerCase();
		} catch {
			return String(clusterUrlRaw || '').trim().toLowerCase();
		}
	}

	private async buildSnapshot(): Promise<Snapshot> {
		const connections = this.connectionManager.getConnections();
		const favorites = this.getFavorites();
		const cachedDatabases = this.getCachedDatabases();
		const expandedClusters = this.getExpandedClusters();

		return {
			timestamp: Date.now(),
			connections,
			favorites,
			cachedDatabases,
			expandedClusters
		};
	}

	private async onMessage(msg: IncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'requestSnapshot': {
				const snapshot = await this.buildSnapshot();
				this.panel.webview.postMessage({ type: 'snapshot', snapshot });
				return;
			}

			case 'connection.add': {
				const name = String(msg.name || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;

				if (!name || !clusterUrl) {
					void vscode.window.showErrorMessage('Connection name and cluster URL are required.');
					return;
				}

				try {
					await this.connectionManager.addConnection({ name, clusterUrl, database });
					void vscode.window.setStatusBarMessage(`Connection "${name}" added successfully`, 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to add connection: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case 'connection.edit': {
				const id = String(msg.id || '').trim();
				const name = String(msg.name || '').trim();
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;

				if (!id || !name || !clusterUrl) {
					void vscode.window.showErrorMessage('Connection ID, name, and cluster URL are required.');
					return;
				}

				try {
					await this.connectionManager.updateConnection(id, { name, clusterUrl, database });
					void vscode.window.setStatusBarMessage(`Connection "${name}" updated successfully`, 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to update connection: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case 'connection.delete': {
				const id = String(msg.id || '').trim();
				if (!id) {
					return;
				}

				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				const connName = conn?.name || id;

				const confirm = await vscode.window.showWarningMessage(
					`Delete connection "${connName}"?`,
					{ modal: true },
					'Delete'
				);
				if (confirm !== 'Delete') {
					return;
				}

				try {
					// Also remove favorites associated with this connection's clusterUrl
					if (conn) {
						const normalizedUrl = this.normalizeFavoriteClusterUrl(conn.clusterUrl);
						const favorites = this.getFavorites().filter((f) => {
							const fUrl = this.normalizeFavoriteClusterUrl(f.clusterUrl);
							return fUrl !== normalizedUrl;
						});
						await this.setFavorites(favorites);
					}

					await this.connectionManager.removeConnection(id);
					void vscode.window.setStatusBarMessage(`Connection "${connName}" deleted`, 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case 'connection.test': {
				const id = String(msg.id || '').trim();
				if (!id) {
					return;
				}

				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				if (!conn) {
					void vscode.window.showErrorMessage('Connection not found.');
					return;
				}

				this.panel.webview.postMessage({ type: 'testConnectionStarted', connectionId: id });

				try {
					const databases = await this.kustoClient.getDatabases(conn, true);
					this.panel.webview.postMessage({
						type: 'testConnectionResult',
						connectionId: id,
						success: true,
						message: `Connected successfully! Found ${databases.length} database(s).`,
						databases
					});

					// Update cached databases
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					if (clusterKey && databases.length > 0) {
						const cached = this.getCachedDatabases();
						cached[clusterKey] = databases;
						await this.setCachedDatabases(cached);
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({
						type: 'testConnectionResult',
						connectionId: id,
						success: false,
						message: isAuthError
							? 'Authentication failed. Please sign in when prompted.'
							: `Connection failed: ${errorMsg}`,
						isAuthError
					});
				}
				return;
			}

			case 'connection.duplicate': {
				const id = String(msg.id || '').trim();
				if (!id) {
					return;
				}

				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === id);
				if (!conn) {
					void vscode.window.showErrorMessage('Connection not found.');
					return;
				}

				try {
					await this.connectionManager.addConnection({
						name: `${conn.name} (copy)`,
						clusterUrl: conn.clusterUrl,
						database: conn.database
					});
					void vscode.window.setStatusBarMessage(`Connection duplicated`, 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to duplicate connection: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case 'favorite.add': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				const name = String(msg.name || '').trim();
				if (!clusterUrl || !database || !name) {
					return;
				}

				// Check if already exists using normalized comparison
				if (this.isFavorite(clusterUrl, database)) {
					return;
				}

				const favorites = this.getFavorites();
				favorites.push({ name, clusterUrl, database });
				await this.setFavorites(favorites);
				return;
			}

			case 'favorite.remove': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				const database = String(msg.database || '').trim();
				if (!clusterUrl || !database) {
					return;
				}

				const normalizedUrl = this.normalizeFavoriteClusterUrl(clusterUrl);
				const normalizedDb = database.toLowerCase();
				const favorites = this.getFavorites().filter((f) => {
					const fUrl = this.normalizeFavoriteClusterUrl(f.clusterUrl);
					const fDb = String(f.database || '').trim().toLowerCase();
					return !(fUrl === normalizedUrl && fDb === normalizedDb);
				});
				await this.setFavorites(favorites);
				return;
			}

			case 'favorite.reorder': {
				if (Array.isArray(msg.favorites)) {
					await this.setFavorites(msg.favorites);
				}
				return;
			}

			case 'cluster.expand': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					return;
				}

				const expanded = this.getExpandedClusters();
				if (!expanded.includes(connectionId)) {
					expanded.push(connectionId);
					await this.setExpandedClusters(expanded);
				}

				// Load databases if not cached
				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (conn) {
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					if (!cached[clusterKey] || cached[clusterKey].length === 0) {
						this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
						try {
							const databases = await this.kustoClient.getDatabases(conn, false, { allowInteractive: false });
							cached[clusterKey] = databases;
							await this.setCachedDatabases(cached);
							this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
						} catch (error) {
							this.panel.webview.postMessage({
								type: 'databasesLoadError',
								connectionId,
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}
				}
				return;
			}

			case 'cluster.collapse': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					return;
				}

				const expanded = this.getExpandedClusters().filter((id) => id !== connectionId);
				await this.setExpandedClusters(expanded);
				return;
			}

			case 'cluster.refreshDatabases': {
				const connectionId = String(msg.connectionId || '').trim();
				if (!connectionId) {
					return;
				}

				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) {
					return;
				}

				this.panel.webview.postMessage({ type: 'loadingDatabases', connectionId });
				try {
					const databases = await this.kustoClient.getDatabases(conn, true);
					const clusterKey = this.getClusterCacheKey(conn.clusterUrl);
					const cached = this.getCachedDatabases();
					cached[clusterKey] = databases;
					await this.setCachedDatabases(cached);
					this.panel.webview.postMessage({ type: 'databasesLoaded', connectionId, databases });
				} catch (error) {
					const isAuthError = this.kustoClient.isAuthenticationError(error);
					this.panel.webview.postMessage({
						type: 'databasesLoadError',
						connectionId,
						error: isAuthError
							? 'Authentication required. Please test the connection to sign in.'
							: error instanceof Error
								? error.message
								: String(error)
					});
				}
				return;
			}

			case 'database.getSchema': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = String(msg.database || '').trim();
				if (!connectionId || !database) {
					return;
				}

				const connections = this.connectionManager.getConnections();
				const conn = connections.find((c) => c.id === connectionId);
				if (!conn) {
					return;
				}

				this.panel.webview.postMessage({ type: 'loadingSchema', connectionId, database });

				try {
					const result = await this.kustoClient.getDatabaseSchema(conn, database, false);
					this.panel.webview.postMessage({
						type: 'schemaLoaded',
						connectionId,
						database,
						schema: result.schema,
						fromCache: result.fromCache,
						cacheAgeMs: result.cacheAgeMs
					});
				} catch (error) {
					this.panel.webview.postMessage({
						type: 'schemaLoadError',
						connectionId,
						database,
						error: error instanceof Error ? error.message : String(error)
					});
				}
				return;
			}

			case 'copyToClipboard': {
				try {
					await vscode.env.clipboard.writeText(String(msg.text ?? ''));
					void vscode.window.setStatusBarMessage('Copied to clipboard', 1500);
				} catch {
					void vscode.window.showErrorMessage('Could not copy to clipboard.');
				}
				return;
			}

			case 'openInEditor': {
				const connectionId = String(msg.connectionId || '').trim();
				const database = msg.database ? String(msg.database).trim() : undefined;
				if (!connectionId) {
					return;
				}

				// Open the query editor with this connection pre-selected
				try {
					await vscode.commands.executeCommand('kusto.openQueryEditor');
					// The webview will handle setting the connection
				} catch (error) {
					void vscode.window.showErrorMessage('Failed to open query editor.');
				}
				return;
			}

			default:
				return;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
		const csp = [
			"default-src 'none'",
			"img-src data:",
			`style-src 'unsafe-inline' ${webview.cspSource}`,
			`script-src 'nonce-${nonce}' ${webview.cspSource}`
		].join('; ');

		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${VIEW_TITLE}</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
		body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
			margin: 0;
		}

		h1 { font-size: 18px; margin: 0 0 16px 0; font-weight: 600; }
		h2 { font-size: 14px; margin: 16px 0 8px 0; font-weight: 600; }
		.small { opacity: 0.8; font-size: 12px; }
		.mono { font-family: var(--vscode-editor-font-family); }

		/* Main layout */
		.main-container {
			display: grid;
			grid-template-columns: 340px 1fr;
			gap: 20px;
			min-height: calc(100vh - 100px);
		}

		/* Sections */
		.section {
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
			overflow: hidden;
		}

		.section-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 12px 14px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}

		.section-header.collapsible {
			cursor: pointer;
			user-select: none;
		}

		.section-header.collapsible:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.section-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
		}

		.section-icon svg {
			width: 16px;
			height: 16px;
			fill: currentColor;
		}

		.section-icon.star {
			color: #f5c518;
		}

		.section-chevron {
			width: 20px;
			height: 20px;
			margin-left: auto;
			transition: transform 0.15s ease;
			flex-shrink: 0;
			opacity: 0.7;
			transform: rotate(180deg);
		}

		.section-chevron svg {
			width: 16px;
			height: 16px;
		}

		.section-header:hover .section-chevron {
			opacity: 1;
		}

		.section-chevron.expanded {
			transform: rotate(90deg);
		}

		.section-body.collapsed {
			display: none;
		}

		.section-collapsed-hint {
			display: none;
			padding: 8px 14px;
			font-size: 11px;
			opacity: 0.5;
		}

		.section-body.collapsed + .section-collapsed-hint {
			display: block;
		}

		.section-title {
			font-weight: 600;
			font-size: 13px;
		}

		.section-body {
			padding: 12px 14px;
			overflow-y: auto;
			max-height: calc(100vh - 200px);
		}

		/* Buttons */
		.btn {
			font-family: inherit;
			font-size: 12px;
			padding: 6px 12px;
			border-radius: 2px;
			border: 1px solid var(--vscode-button-border, transparent);
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}

		.btn-primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.btn-primary:hover { background: var(--vscode-button-hoverBackground); }

		.btn-secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

		.btn-icon {
			width: 28px;
			height: 28px;
			padding: 0;
			border: none;
			background: transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 4px;
		}
		.btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
		.btn-icon:active { background: var(--vscode-toolbar-activeBackground); }
		.btn-icon svg { width: 16px; height: 16px; fill: currentColor; }

		.btn-icon.header-action {
			width: 28px;
			height: 28px;
			margin-top: 2px;
		}
		.btn-icon.header-action:hover { background: var(--vscode-toolbar-hoverBackground); }
		.btn-icon.header-action svg { width: 18px; height: 18px; }

		.btn-icon.favorite { 
			color: var(--vscode-foreground); 
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.1s;
		}
		.tree-node-content:hover .btn-icon.favorite { 
			opacity: 1; 
			pointer-events: auto; 
		}
		.btn-icon.favorite.is-favorite { 
			color: #f5c518; 
			opacity: 1;
			pointer-events: auto;
		}
		.btn-icon.favorite.is-favorite svg { fill: #f5c518; }

		/* Form inputs */
		.form-group {
			margin-bottom: 12px;
		}

		.form-group label {
			display: block;
			margin-bottom: 4px;
			font-size: 12px;
			color: var(--vscode-foreground);
		}

		.form-group input,
		.form-group select {
			width: 100%;
			padding: 6px 8px;
			font-size: 13px;
			font-family: inherit;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
		}

		.form-group input:focus,
		.form-group select:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.form-group input::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}

		.form-actions {
			display: flex;
			gap: 8px;
			margin-top: 16px;
		}

		/* Connection list */
		.connection-list {
			list-style: none;
			margin: 0;
			padding: 0;
		}

		.connection-item {
			display: flex;
			flex-direction: column;
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			cursor: pointer;
			transition: background 0.1s;
		}

		.connection-item:last-child {
			border-bottom: none;
		}

		.connection-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.connection-item.selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		.connection-row {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.connection-name {
			flex: 1;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.connection-url {
			font-size: 11px;
			opacity: 0.7;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-top: 2px;
		}

		.connection-actions {
			display: flex;
			gap: 2px;
			opacity: 0;
			transition: opacity 0.1s;
			flex-shrink: 0;
		}

		.connection-item:hover .connection-actions {
			opacity: 1;
		}

		/* Favorites section */
		.favorites-section {
			margin-bottom: 16px;
		}

		.favorite-item {
			display: flex;
			align-items: flex-start;
			gap: 10px;
			padding: 10px 12px;
			border-radius: 4px;
			background: var(--vscode-list-hoverBackground);
			margin-bottom: 6px;
			cursor: pointer;
		}

		.favorite-item:hover {
			background: var(--vscode-badge-background);
		}

		.favorite-info {
			flex: 1;
			min-width: 0;
			overflow: hidden;
		}

		.favorite-name {
			font-size: 13px;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-bottom: 2px;
		}

		.favorite-detail {
			font-size: 11px;
			opacity: 0.7;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.favorite-actions {
			flex-shrink: 0;
			opacity: 0;
			transition: opacity 0.1s;
		}

		.favorite-item:hover .favorite-actions {
			opacity: 1;
		}

		/* Explorer tree */
		.tree-view {
			font-size: 13px;
		}

		.tree-node {
			user-select: none;
		}

		.tree-node-content {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			cursor: pointer;
			border-radius: 3px;
		}

		.tree-node-content:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.tree-node-content.selected {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		.tree-chevron {
			width: 16px;
			height: 16px;
			display: flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
		}

		.tree-chevron svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
			transition: transform 0.1s;
		}

		.tree-chevron.expanded svg {
			transform: rotate(90deg);
		}

		.tree-chevron.loading svg {
			animation: spin 1s linear infinite;
		}

		@keyframes spin {
			from { transform: rotate(0deg); }
			to { transform: rotate(360deg); }
		}

		.tree-icon {
			width: 16px;
			height: 16px;
			display: flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
		}

		.tree-icon svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
		}

		.tree-icon.cluster svg { fill: var(--vscode-symbolIcon-classForeground, #ee9d28); }
		.tree-icon.database svg { fill: var(--vscode-symbolIcon-namespaceForeground, #6c71c4); }
		.tree-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #2aa198); }
		.tree-icon.function svg { fill: var(--vscode-symbolIcon-functionForeground, #859900); }
		.tree-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #b58900); }

		.tree-label {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.tree-badge {
			font-size: 10px;
			padding: 1px 5px;
			border-radius: 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}

		.tree-children {
			padding-left: 20px;
		}

		/* Detail panel */
		.detail-panel {
			padding: 16px;
		}

		.detail-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			margin-bottom: 16px;
		}

		.detail-title {
			font-size: 16px;
			font-weight: 600;
			margin: 0 0 4px 0;
		}

		.detail-subtitle {
			font-size: 12px;
			opacity: 0.7;
		}

		.detail-actions {
			display: flex;
			gap: 8px;
		}

		.detail-section {
			margin-top: 20px;
		}

		.detail-section-title {
			font-size: 12px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			opacity: 0.7;
			margin-bottom: 8px;
		}

		/* Schema table */
		.schema-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}

		.schema-table th,
		.schema-table td {
			text-align: left;
			padding: 6px 10px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.schema-table th {
			font-weight: 600;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}

		.schema-table tr:hover td {
			background: var(--vscode-list-hoverBackground);
		}

		/* Status indicators */
		.status-indicator {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			border-radius: 3px;
			font-size: 12px;
		}

		.status-indicator.success {
			background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
			color: var(--vscode-testing-iconPassed);
		}

		.status-indicator.error {
			background: color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent);
			color: var(--vscode-testing-iconFailed);
		}

		.status-indicator.loading {
			background: color-mix(in srgb, var(--vscode-progressBar-background) 20%, transparent);
			color: var(--vscode-progressBar-background);
		}

		/* Empty states */
		.empty-state {
			text-align: center;
			padding: 40px 20px;
			color: var(--vscode-descriptionForeground);
		}

		.empty-state-icon {
			font-size: 48px;
			margin-bottom: 16px;
			opacity: 0.5;
		}

		.empty-state-title {
			font-size: 14px;
			font-weight: 500;
			margin-bottom: 8px;
		}

		.empty-state-text {
			font-size: 12px;
			margin-bottom: 16px;
		}

		/* Modal */
		.modal-overlay {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.5);
			z-index: 1000;
			align-items: center;
			justify-content: center;
		}

		.modal-overlay.visible {
			display: flex;
		}

		.modal {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			width: 400px;
			max-width: 90vw;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		}

		.modal-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 14px 16px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.modal-title {
			font-size: 14px;
			font-weight: 600;
		}

		.modal-body {
			padding: 16px;
		}

		.modal-footer {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			padding: 12px 16px;
			border-top: 1px solid var(--vscode-panel-border);
		}

		/* Scrollbars */
		::-webkit-scrollbar { width: 10px; height: 10px; }
		::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
		::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
		::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
	</style>
</head>
<body>
	<h1>${VIEW_TITLE}</h1>

	<div class="main-container">
		<!-- Left Panel: Connections List -->
		<div class="left-panel">
			<!-- Favorites Section -->
			<div id="favoritesSection" class="section favorites-section" style="display: none;">
				<div class="section-header collapsible" data-toggle-section="favorites">
					<span class="section-icon star">${this.getStarFilledIcon()}</span>
					<span class="section-title">Favorites</span>
					<span class="section-chevron">${this.getChevronIcon()}</span>
				</div>
				<div class="section-body collapsed" id="favoritesList"></div>
				<div class="section-collapsed-hint">Expand section to view items</div>
			</div>

			<!-- All Clusters -->
			<div class="section" id="connectionsSection">
				<div class="section-header collapsible" data-toggle-section="connections">
					<span class="section-icon">${this.getClusterIcon()}</span>
					<span class="section-title">Clusters</span>
					<button class="btn-icon header-action" id="addConnectionBtn" title="Add new cluster">
						${this.getAddIcon()}
					</button>
					<span class="section-chevron expanded">${this.getChevronIcon()}</span>
				</div>
				<div class="section-body" id="connectionsList">
					<div class="empty-state">
						<div class="empty-state-icon">${this.getClusterIcon()}</div>
						<div class="empty-state-title">No clusters yet</div>
						<div class="empty-state-text">Add a Kusto cluster to get started.</div>
					</div>
				</div>
				<div class="section-collapsed-hint">Expand section to view items</div>
			</div>
		</div>

		<!-- Right Panel: Explorer & Details -->
		<div class="right-panel">
			<div class="section" style="height: 100%;">
				<div class="section-header">
					<span class="section-title">Cluster Explorer</span>
				</div>
				<div class="section-body" id="explorerContent">
					<div class="empty-state">
						<div class="empty-state-icon">${this.getDatabaseIcon()}</div>
						<div class="empty-state-title">Select a connection</div>
						<div class="empty-state-text">Click on a connection to explore its databases, tables, and functions.</div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Add/Edit Connection Modal -->
	<div class="modal-overlay" id="connectionModal">
		<div class="modal">
			<div class="modal-header">
				<span class="modal-title" id="modalTitle">Add Connection</span>
				<button class="btn-icon" id="modalCloseBtn" title="Close">
					${this.getCloseIcon()}
				</button>
			</div>
			<div class="modal-body">
				<div class="form-group">
					<label for="connName">Connection Name *</label>
					<input type="text" id="connName" placeholder="My Kusto Cluster" />
				</div>
				<div class="form-group">
					<label for="connUrl">Cluster URL *</label>
					<input type="text" id="connUrl" placeholder="https://mycluster.region.kusto.windows.net" />
				</div>
				<div class="form-group">
					<label for="connDb">Default Database (optional)</label>
					<input type="text" id="connDb" placeholder="MyDatabase" />
				</div>
				<div id="testResult" style="margin-top: 12px;"></div>
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" id="testConnectionBtn">Test Connection</button>
				<button class="btn btn-secondary" id="modalCancelBtn">Cancel</button>
				<button class="btn btn-primary" id="modalSaveBtn">Save</button>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		var vscode = acquireVsCodeApi();
		var lastSnapshot = null;
		var selectedConnectionId = null;
		var editingConnectionId = null;
		var expandedDatabases = new Set();
		var expandedFolders = new Set(); // Track expanded Tables/Functions folders
		var loadingDatabases = new Set();
		var databaseSchemas = {};

		// Icons
		var ICONS = {
			cluster: '${this.escapeJs(this.getClusterIcon())}',
			database: '${this.escapeJs(this.getDatabaseIcon())}',
			table: '${this.escapeJs(this.getTableIcon())}',
			function: '${this.escapeJs(this.getFunctionIcon())}',
			folder: '${this.escapeJs(this.getFolderIcon())}',
			chevron: '${this.escapeJs(this.getChevronIcon())}',
			star: '${this.escapeJs(this.getStarIcon())}',
			starFilled: '${this.escapeJs(this.getStarFilledIcon())}',
			edit: '${this.escapeJs(this.getEditIcon())}',
			delete: '${this.escapeJs(this.getDeleteIcon())}',
			copy: '${this.escapeJs(this.getCopyIcon())}',
			refresh: '${this.escapeJs(this.getRefreshIcon())}',
			spinner: '${this.escapeJs(this.getSpinnerIcon())}'
		};

		function escapeHtml(str) {
			return String(str || '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#x27;');
		}

		function shortClusterName(url) {
			try {
				var s = String(url || '').trim();
				if (!s) return '(unknown)';
				if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s;
				var parsed = new URL(s);
				var host = String(parsed.hostname || '').toLowerCase();
				// Extract just the cluster name part
				var match = host.match(/^([^.]+)/);
				return match ? match[1] : host;
			} catch {
				return String(url || '').substring(0, 20);
			}
		}

		function normalizeClusterUrl(url) {
			var s = String(url || '').trim();
			if (!s) return '';
			if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s;
			return s.replace(/\\/+$/g, '').toLowerCase();
		}

		function isFavorite(clusterUrl, database) {
			if (!lastSnapshot || !lastSnapshot.favorites) return false;
			var normalizedUrl = normalizeClusterUrl(clusterUrl);
			var normalizedDb = String(database || '').trim().toLowerCase();
			return lastSnapshot.favorites.some(function(f) {
				var fUrl = normalizeClusterUrl(f.clusterUrl);
				var fDb = String(f.database || '').trim().toLowerCase();
				return fUrl === normalizedUrl && fDb === normalizedDb;
			});
		}

		function renderFavorites() {
			var section = document.getElementById('favoritesSection');
			var list = document.getElementById('favoritesList');
			
			// Only show database favorites (filter out any cluster-only favorites)
			var dbFavorites = (lastSnapshot && lastSnapshot.favorites) 
				? lastSnapshot.favorites.filter(function(f) { return f.database && f.clusterUrl; })
				: [];
			
			if (dbFavorites.length === 0) {
				section.style.display = 'none';
				return;
			}

			section.style.display = 'block';
			var html = '';
			
			// Build a map of clusterUrl -> connection for finding matching connections
			var connectionsByClusterUrl = {};
			if (lastSnapshot && lastSnapshot.connections) {
				lastSnapshot.connections.forEach(function(c) {
					var key = normalizeClusterUrl(c.clusterUrl);
					if (key && !connectionsByClusterUrl[key]) {
						connectionsByClusterUrl[key] = c;
					}
				});
			}

			dbFavorites.forEach(function(fav) {
				var normalizedUrl = normalizeClusterUrl(fav.clusterUrl);
				var conn = connectionsByClusterUrl[normalizedUrl];
				
				// Use the favorite's stored name, or connection name, or cluster short name
				var displayName = fav.name || (conn ? conn.name : shortClusterName(fav.clusterUrl));
				var clusterShort = shortClusterName(fav.clusterUrl);
				var detailLine = clusterShort + '.' + fav.database;
				var tooltipText = displayName + '\\n' + detailLine;

				html += '<div class="favorite-item" title="' + escapeHtml(displayName + ' — ' + detailLine) + '" data-fav-cluster="' + escapeHtml(fav.clusterUrl) + '" data-fav-db="' + escapeHtml(fav.database) + '"' + (conn ? ' data-fav-conn="' + escapeHtml(conn.id) + '"' : '') + '>';
				html += '<div class="favorite-info">';
				html += '<div class="favorite-name">' + escapeHtml(displayName) + '</div>';
				html += '<div class="favorite-detail">' + escapeHtml(detailLine) + '</div>';
				html += '</div>';
				html += '<div class="favorite-actions">';
				html += '<button class="btn-icon" data-remove-fav-cluster="' + escapeHtml(fav.clusterUrl) + '" data-remove-fav-db="' + escapeHtml(fav.database) + '" title="Remove from favorites">' + ICONS.delete + '</button>';
				html += '</div>';
				html += '</div>';
			});

			list.innerHTML = html;
		}

		function renderConnections() {
			var list = document.getElementById('connectionsList');
			if (!lastSnapshot || !lastSnapshot.connections || lastSnapshot.connections.length === 0) {
				list.innerHTML = '<div class="empty-state">' +
					'<div class="empty-state-icon">' + ICONS.cluster + '</div>' +
					'<div class="empty-state-title">No clusters yet</div>' +
					'<div class="empty-state-text">Add a Kusto cluster to get started.</div>' +
					'</div>';
				return;
			}

			var html = '<ul class="connection-list">';
			lastSnapshot.connections.forEach(function(conn) {
				var isSelected = conn.id === selectedConnectionId;
				var fullUrl = conn.clusterUrl;
				if (!/^https?:\\/\\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl;
				html += '<li class="connection-item' + (isSelected ? ' selected' : '') + '" data-conn-id="' + escapeHtml(conn.id) + '">';
				html += '<div class="connection-row">';
				html += '<div class="connection-name">' + escapeHtml(conn.name) + '</div>';
				html += '<div class="connection-actions">';
				html += '<button class="btn-icon" data-edit-conn="' + escapeHtml(conn.id) + '" title="Edit cluster">' + ICONS.edit + '</button>';
				html += '<button class="btn-icon" data-copy-url="' + escapeHtml(conn.clusterUrl) + '" title="Copy cluster URL">' + ICONS.copy + '</button>';
				html += '<button class="btn-icon" data-delete-conn="' + escapeHtml(conn.id) + '" title="Delete cluster">' + ICONS.delete + '</button>';
				html += '</div>';
				html += '</div>';
				html += '<div class="connection-url mono">' + escapeHtml(fullUrl) + '</div>';
				html += '</li>';
			});
			html += '</ul>';

			list.innerHTML = html;
		}

		function renderExplorer() {
			var content = document.getElementById('explorerContent');
			if (!selectedConnectionId || !lastSnapshot) {
				content.innerHTML = '<div class="empty-state">' +
					'<div class="empty-state-icon">' + ICONS.database + '</div>' +
					'<div class="empty-state-title">Select a connection</div>' +
					'<div class="empty-state-text">Click on a connection to explore its databases, tables, and functions.</div>' +
					'</div>';
				return;
			}

			var conn = lastSnapshot.connections.find(function(c) { return c.id === selectedConnectionId; });
			if (!conn) {
				content.innerHTML = '<div class="empty-state">Connection not found</div>';
				return;
			}

			// Get cluster cache key
			var clusterKey = '';
			try {
				var url = conn.clusterUrl;
				if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;
				var parsed = new URL(url);
				clusterKey = parsed.hostname.toLowerCase();
			} catch { clusterKey = conn.clusterUrl.toLowerCase(); }

			var databases = lastSnapshot.cachedDatabases[clusterKey] || [];
			var isLoading = loadingDatabases.has(conn.id);

			var html = '<div class="tree-view">';
			
			// Header with connection name and refresh button
			html += '<div class="explorer-header" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-editorWidget-border);">';
			html += '<span class="tree-icon cluster">' + ICONS.cluster + '</span>';
			html += '<span style="font-weight: 500; flex: 1;">' + escapeHtml(conn.name) + '</span>';
			if (isLoading) {
				html += '<span class="tree-chevron loading">' + ICONS.spinner + '</span>';
			}
			html += '<button class="btn-icon" data-refresh-cluster="' + escapeHtml(conn.id) + '" title="Refresh databases">' + ICONS.refresh + '</button>';
			html += '</div>';

			if (databases.length > 0) {
				databases.forEach(function(db) {
					var dbKey = conn.id + '|' + db;
					var dbExpanded = expandedDatabases.has(dbKey);
					var schema = databaseSchemas[dbKey];
					var dbFav = isFavorite(conn.clusterUrl, db);

					html += '<div class="tree-node">';
					html += '<div class="tree-node-content" data-expand-db="' + escapeHtml(conn.id) + '" data-db-name="' + escapeHtml(db) + '">';
					html += '<span class="tree-chevron' + (dbExpanded ? ' expanded' : '') + '">' + ICONS.chevron + '</span>';
					html += '<span class="tree-icon database">' + ICONS.database + '</span>';
					html += '<span class="tree-label">' + escapeHtml(db) + '</span>';
					html += '<button class="btn-icon favorite' + (dbFav ? ' is-favorite' : '') + '" data-toggle-db-fav="' + escapeHtml(conn.id) + '" data-toggle-db-fav-cluster="' + escapeHtml(conn.clusterUrl) + '" data-toggle-db-fav-name="' + escapeHtml(conn.name) + '" data-db="' + escapeHtml(db) + '" title="' + (dbFav ? 'Remove from favorites' : 'Add to favorites') + '" style="margin-left: auto;">' + (dbFav ? ICONS.starFilled : ICONS.star) + '</button>';
					html += '</div>';

					if (dbExpanded && schema) {
						html += '<div class="tree-children">';
						
						// Tables folder
						if (schema.tables && schema.tables.length > 0) {
							var tablesFolderKey = dbKey + '|tables';
							var tablesExpanded = expandedFolders.has(tablesFolderKey);
							html += '<div class="tree-node">';
							html += '<div class="tree-node-content" data-toggle-folder="' + escapeHtml(tablesFolderKey) + '">';
							html += '<span class="tree-chevron' + (tablesExpanded ? ' expanded' : '') + '">' + ICONS.chevron + '</span>';
							html += '<span class="tree-icon folder">' + ICONS.folder + '</span>';
							html += '<span class="tree-label">Tables</span>';
							html += '<span class="tree-badge">' + schema.tables.length + '</span>';
							html += '</div>';
							if (tablesExpanded) {
								html += '<div class="tree-children">';
								schema.tables.slice(0, 100).forEach(function(table) {
									var cols = schema.columnTypesByTable[table] || {};
									var colCount = Object.keys(cols).length;
									html += '<div class="tree-node">';
									html += '<div class="tree-node-content" data-table="' + escapeHtml(table) + '" data-db="' + escapeHtml(db) + '" data-conn="' + escapeHtml(conn.id) + '">';
									html += '<span class="tree-chevron"></span>';
									html += '<span class="tree-icon table">' + ICONS.table + '</span>';
									html += '<span class="tree-label">' + escapeHtml(table) + '</span>';
									if (colCount > 0) html += '<span class="tree-badge">' + colCount + ' cols</span>';
									html += '</div>';
									html += '</div>';
								});
								if (schema.tables.length > 100) {
									html += '<div class="tree-node"><div class="tree-node-content small">...and ' + (schema.tables.length - 100) + ' more tables</div></div>';
								}
								html += '</div>';
							}
							html += '</div>';
						}

						// Functions folder
						if (schema.functions && schema.functions.length > 0) {
							var fnFolderKey = dbKey + '|functions';
							var fnExpanded = expandedFolders.has(fnFolderKey);
							html += '<div class="tree-node">';
							html += '<div class="tree-node-content" data-toggle-folder="' + escapeHtml(fnFolderKey) + '">';
							html += '<span class="tree-chevron' + (fnExpanded ? ' expanded' : '') + '">' + ICONS.chevron + '</span>';
							html += '<span class="tree-icon folder">' + ICONS.folder + '</span>';
							html += '<span class="tree-label">Functions</span>';
							html += '<span class="tree-badge">' + schema.functions.length + '</span>';
							html += '</div>';
							if (fnExpanded) {
								html += '<div class="tree-children">';
								schema.functions.slice(0, 50).forEach(function(fn) {
									html += '<div class="tree-node">';
									html += '<div class="tree-node-content" data-fn="' + escapeHtml(fn.name) + '" data-db="' + escapeHtml(db) + '" data-conn="' + escapeHtml(conn.id) + '">';
									html += '<span class="tree-chevron"></span>';
									html += '<span class="tree-icon function">' + ICONS.function + '</span>';
									html += '<span class="tree-label">' + escapeHtml(fn.name) + '</span>';
									html += '</div>';
									html += '</div>';
								});
								if (schema.functions.length > 50) {
									html += '<div class="tree-node"><div class="tree-node-content small">...and ' + (schema.functions.length - 50) + ' more functions</div></div>';
								}
								html += '</div>';
							}
							html += '</div>';
						}

						html += '</div>';
					} else if (dbExpanded && !schema) {
						html += '<div class="tree-children">';
						html += '<div class="tree-node"><div class="tree-node-content small">Loading schema...</div></div>';
						html += '</div>';
					}

					html += '</div>';
				});
			} else if (!isLoading && databases.length === 0) {
				html += '<div class="tree-node"><div class="tree-node-content small">No databases found. Click refresh to load.</div></div>';
			}

			html += '</div>';

			content.innerHTML = html;
		}

		function renderAll() {
			renderFavorites();
			renderConnections();
			renderExplorer();
		}

		function openModal(mode, connId) {
			editingConnectionId = (mode === 'edit') ? connId : null;
			var modal = document.getElementById('connectionModal');
			var title = document.getElementById('modalTitle');
			var nameInput = document.getElementById('connName');
			var urlInput = document.getElementById('connUrl');
			var dbInput = document.getElementById('connDb');
			var testResult = document.getElementById('testResult');

			testResult.innerHTML = '';

			if (mode === 'edit' && connId && lastSnapshot) {
				var conn = lastSnapshot.connections.find(function(c) { return c.id === connId; });
				if (conn) {
					title.textContent = 'Edit Connection';
					nameInput.value = conn.name || '';
					urlInput.value = conn.clusterUrl || '';
					dbInput.value = conn.database || '';
				}
			} else {
				title.textContent = 'Add Connection';
				nameInput.value = '';
				urlInput.value = '';
				dbInput.value = '';
			}

			modal.classList.add('visible');
			nameInput.focus();
		}

		function closeModal() {
			var modal = document.getElementById('connectionModal');
			modal.classList.remove('visible');
			editingConnectionId = null;
		}

		function saveConnection() {
			var name = document.getElementById('connName').value.trim();
			var url = document.getElementById('connUrl').value.trim();
			var db = document.getElementById('connDb').value.trim();

			if (!name || !url) {
				alert('Connection name and cluster URL are required.');
				return;
			}

			if (editingConnectionId) {
				vscode.postMessage({ type: 'connection.edit', id: editingConnectionId, name: name, clusterUrl: url, database: db || undefined });
			} else {
				vscode.postMessage({ type: 'connection.add', name: name, clusterUrl: url, database: db || undefined });
			}

			closeModal();
			setTimeout(function() { vscode.postMessage({ type: 'requestSnapshot' }); }, 100);
		}

		function testConnection() {
			var url = document.getElementById('connUrl').value.trim();
			if (!url) {
				alert('Please enter a cluster URL first.');
				return;
			}

			var testResult = document.getElementById('testResult');
			testResult.innerHTML = '<div class="status-indicator loading">' + ICONS.spinner + ' Testing connection...</div>';

			// If editing, test the existing connection; otherwise create a temporary one
			if (editingConnectionId) {
				vscode.postMessage({ type: 'connection.test', id: editingConnectionId });
			} else {
				// For new connections, we need to save first then test
				var name = document.getElementById('connName').value.trim() || 'Test';
				vscode.postMessage({ type: 'connection.add', name: name, clusterUrl: url });
				// The test will happen after the connection is added
			}
		}

		// Event listeners
		document.getElementById('addConnectionBtn').addEventListener('click', function() {
			openModal('add');
		});

		document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
		document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
		document.getElementById('modalSaveBtn').addEventListener('click', saveConnection);
		document.getElementById('testConnectionBtn').addEventListener('click', testConnection);

		// Section toggle (collapsible Favorites/Connections)
		var collapsedSections = new Set(['favorites']); // Favorites collapsed by default
		document.querySelectorAll('[data-toggle-section]').forEach(function(header) {
			header.addEventListener('click', function(e) {
				// Don't toggle if clicking a button inside the header
				if (e.target.closest('.btn') || e.target.closest('.btn-icon')) return;
				
				var section = header.getAttribute('data-toggle-section');
				var chevron = header.querySelector('.section-chevron');
				var body = header.closest('.section').querySelector('.section-body');
				var hint = header.closest('.section').querySelector('.section-collapsed-hint');
				
				if (collapsedSections.has(section)) {
					collapsedSections.delete(section);
					chevron.classList.add('expanded');
					body.classList.remove('collapsed');
				} else {
					collapsedSections.add(section);
					chevron.classList.remove('expanded');
					body.classList.add('collapsed');
				}
			});
		});

		// Delegate clicks
		document.addEventListener('click', function(e) {
			var target = e.target;
			if (!target || target.nodeType !== 1) return;

			// Find closest matching element
			function closest(el, selector) {
				while (el && el !== document) {
					if (el.matches && el.matches(selector)) return el;
					el = el.parentNode;
				}
				return null;
			}

			// Connection item click (select)
			var connItem = closest(target, '.connection-item');
			if (connItem && !closest(target, '.btn-icon')) {
				var connId = connItem.getAttribute('data-conn-id');
				if (connId) {
					selectedConnectionId = connId;
					// Auto-expand cluster
					vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
					renderAll();
				}
				return;
			}

			// Toggle favorite (database)
			var toggleDbFav = closest(target, '[data-toggle-db-fav]');
			if (toggleDbFav) {
				var connId = toggleDbFav.getAttribute('data-toggle-db-fav');
				var clusterUrl = toggleDbFav.getAttribute('data-toggle-db-fav-cluster');
				var connName = toggleDbFav.getAttribute('data-toggle-db-fav-name');
				var db = toggleDbFav.getAttribute('data-db');
				if (isFavorite(clusterUrl, db)) {
					vscode.postMessage({ type: 'favorite.remove', clusterUrl: clusterUrl, database: db });
				} else {
					vscode.postMessage({ type: 'favorite.add', clusterUrl: clusterUrl, database: db, name: connName });
				}
				setTimeout(function() { vscode.postMessage({ type: 'requestSnapshot' }); }, 50);
				return;
			}

			// Remove favorite
			var removeFav = closest(target, '[data-remove-fav-cluster]');
			if (removeFav) {
				var clusterUrl = removeFav.getAttribute('data-remove-fav-cluster');
				var db = removeFav.getAttribute('data-remove-fav-db');
				vscode.postMessage({ type: 'favorite.remove', clusterUrl: clusterUrl, database: db });
				setTimeout(function() { vscode.postMessage({ type: 'requestSnapshot' }); }, 50);
				return;
			}

			// Edit connection
			var editConn = closest(target, '[data-edit-conn]');
			if (editConn) {
				var connId = editConn.getAttribute('data-edit-conn');
				openModal('edit', connId);
				return;
			}

			// Delete connection
			var deleteConn = closest(target, '[data-delete-conn]');
			if (deleteConn) {
				var connId = deleteConn.getAttribute('data-delete-conn');
				vscode.postMessage({ type: 'connection.delete', id: connId });
				return;
			}

			// Copy URL
			var copyUrl = closest(target, '[data-copy-url]');
			if (copyUrl) {
				var url = copyUrl.getAttribute('data-copy-url');
				vscode.postMessage({ type: 'copyToClipboard', text: url });
				return;
			}

			// Toggle folder expand/collapse (Tables/Functions)
			var toggleFolder = closest(target, '[data-toggle-folder]');
			if (toggleFolder) {
				var folderKey = toggleFolder.getAttribute('data-toggle-folder');
				if (expandedFolders.has(folderKey)) {
					expandedFolders.delete(folderKey);
				} else {
					expandedFolders.add(folderKey);
				}
				renderExplorer();
				return;
			}

			// Refresh cluster databases
			var refreshCluster = closest(target, '[data-refresh-cluster]');
			if (refreshCluster) {
				var connId = refreshCluster.getAttribute('data-refresh-cluster');
				vscode.postMessage({ type: 'cluster.refreshDatabases', connectionId: connId });
				return;
			}

			// Expand/collapse database
			var expandDb = closest(target, '[data-expand-db]');
			if (expandDb && !closest(target, '[data-toggle-db-fav]')) {
				var connId = expandDb.getAttribute('data-expand-db');
				var db = expandDb.getAttribute('data-db-name');
				var dbKey = connId + '|' + db;
				if (expandedDatabases.has(dbKey)) {
					expandedDatabases.delete(dbKey);
				} else {
					expandedDatabases.add(dbKey);
					// Load schema if not cached
					if (!databaseSchemas[dbKey]) {
						vscode.postMessage({ type: 'database.getSchema', connectionId: connId, database: db });
					}
				}
				renderExplorer();
				return;
			}

			// Favorite item click
			var favItem = closest(target, '.favorite-item');
			if (favItem && !closest(target, '.btn-icon')) {
				var connId = favItem.getAttribute('data-fav-conn');
				var favDb = favItem.getAttribute('data-fav-db');
				
				// Helper function to expand the favorite database
				function expandFavoriteDatabase(connectionId, database) {
					if (connectionId && database) {
						var dbKey = connectionId + '|' + database;
						expandedDatabases.add(dbKey);
						// Load schema if not cached
						if (!databaseSchemas[dbKey]) {
							vscode.postMessage({ type: 'database.getSchema', connectionId: connectionId, database: database });
						}
					}
				}
				
				if (connId) {
					selectedConnectionId = connId;
					vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
					expandFavoriteDatabase(connId, favDb);
					renderAll();
				} else {
					// No matching connection found, try to find one by clusterUrl
					var clusterUrl = favItem.getAttribute('data-fav-cluster');
					if (clusterUrl && lastSnapshot && lastSnapshot.connections) {
						var normalizedUrl = normalizeClusterUrl(clusterUrl);
						for (var i = 0; i < lastSnapshot.connections.length; i++) {
							var c = lastSnapshot.connections[i];
							if (normalizeClusterUrl(c.clusterUrl) === normalizedUrl) {
								selectedConnectionId = c.id;
								vscode.postMessage({ type: 'cluster.expand', connectionId: c.id });
								expandFavoriteDatabase(c.id, favDb);
								renderAll();
								break;
							}
						}
					}
				}
				return;
			}
		});

		// Handle Enter key in modal
		document.getElementById('connectionModal').addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				saveConnection();
			} else if (e.key === 'Escape') {
				closeModal();
			}
		});

		// Handle messages from extension
		window.addEventListener('message', function(event) {
			var msg = event.data;
			if (!msg) return;

			switch (msg.type) {
				case 'snapshot':
					lastSnapshot = msg.snapshot;
					// Auto-select first cluster if none selected
					if (!selectedConnectionId && lastSnapshot && lastSnapshot.connections && lastSnapshot.connections.length > 0) {
						selectedConnectionId = lastSnapshot.connections[0].id;
						vscode.postMessage({ type: 'cluster.expand', connectionId: selectedConnectionId });
					}
					renderAll();
					break;

				case 'testConnectionStarted':
					var testResult = document.getElementById('testResult');
					testResult.innerHTML = '<div class="status-indicator loading">' + ICONS.spinner + ' Testing connection...</div>';
					break;

				case 'testConnectionResult':
					var testResult = document.getElementById('testResult');
					if (msg.success) {
						testResult.innerHTML = '<div class="status-indicator success">✓ ' + escapeHtml(msg.message) + '</div>';
					} else {
						testResult.innerHTML = '<div class="status-indicator error">✗ ' + escapeHtml(msg.message) + '</div>';
					}
					break;

				case 'loadingDatabases':
					loadingDatabases.add(msg.connectionId);
					renderExplorer();
					break;

				case 'databasesLoaded':
					loadingDatabases.delete(msg.connectionId);
					vscode.postMessage({ type: 'requestSnapshot' });
					break;

				case 'databasesLoadError':
					loadingDatabases.delete(msg.connectionId);
					renderExplorer();
					break;

				case 'loadingSchema':
					// Could show loading indicator
					break;

				case 'schemaLoaded':
					var dbKey = msg.connectionId + '|' + msg.database;
					databaseSchemas[dbKey] = msg.schema;
					renderExplorer();
					break;

				case 'schemaLoadError':
					// Could show error
					break;
			}
		});

		// Initial load
		vscode.postMessage({ type: 'requestSnapshot' });
	</script>
</body>
</html>`;
	}

	// SVG Icon helpers
	private escapeJs(str: string): string {
		return str.replace(/'/g, "\\'").replace(/\n/g, '').replace(/\r/g, '');
	}

	private getClusterIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 0 1 .94-3.22l2.83 2.83-2.83 2.83A5.98 5.98 0 0 1 2 8zm4.17 5.06L3.34 10.23 6.17 7.4l2.83 2.83-2.83 2.83zm1.41-4.24L4.75 6l2.83-2.83L10.4 6 7.58 8.82zm4.08 1.41l-2.83-2.83 2.83-2.83A5.98 5.98 0 0 1 14 8a5.98 5.98 0 0 1-2.34 4.77z"/>
		</svg>`;
	}

	private getDatabaseIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1C4.686 1 2 2.119 2 3.5v9C2 13.881 4.686 15 8 15s6-1.119 6-2.5v-9C14 2.119 11.314 1 8 1zm0 1c2.761 0 5 .895 5 2s-2.239 2-5 2-5-.895-5-2 2.239-2 5-2zm5 9.5c0 1.105-2.239 2-5 2s-5-.895-5-2v-2.035C4.17 10.405 5.97 11 8 11s3.83-.595 5-1.535V11.5zm0-4c0 1.105-2.239 2-5 2s-5-.895-5-2V5.465C4.17 6.405 5.97 7 8 7s3.83-.595 5-1.535V7.5z"/>
		</svg>`;
	}

	private getTableIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M14 2H2v12h12V2zm-1 1v3H9V3h4zM3 3h5v3H3V3zm0 4h5v3H3V7zm0 4h5v2H3v-2zm6 2v-2h4v2H9zm4-3H9V7h4v3z"/>
		</svg>`;
	}

	private getFunctionIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M2.5 2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM3 5V3h2v2H3zm7.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM11 5V3h2v2h-2zM2.5 10a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM3 13v-2h2v2H3zm7.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm.5 3v-2h2v2h-2zM8 5.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm-3 3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/>
		</svg>`;
	}

	private getFolderIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zm-.5 10H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/>
		</svg>`;
	}

	private getChevronIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M6 4l4 4-4 4V4z"/>
		</svg>`;
	}

	private getStarIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1.5l2.09 4.26 4.71.69-3.4 3.32.8 4.68L8 12.26l-4.2 2.19.8-4.68-3.4-3.32 4.71-.69L8 1.5z"/>
		</svg>`;
	}

	private getStarFilledIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1.5l2.09 4.26 4.71.69-3.4 3.32.8 4.68L8 12.26l-4.2 2.19.8-4.68-3.4-3.32 4.71-.69L8 1.5z"/>
		</svg>`;
	}

	private getEditIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M13.23 1a.5.5 0 0 0-.35.15l-1.45 1.45 3 3 1.45-1.45a.5.5 0 0 0 0-.7l-2.3-2.3a.5.5 0 0 0-.35-.15zm-2.5 2.3L2 12.03V15h2.97l8.73-8.73-3-3z"/>
		</svg>`;
	}

	private getDeleteIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M5.5 1a.5.5 0 0 0-.5.5V2H2v1h1v10.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V3h1V2h-3v-.5a.5.5 0 0 0-.5-.5h-5zM4 3h8v10.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3z"/>
		</svg>`;
	}

	private getCopyIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M4 4h1V2.5A1.5 1.5 0 0 1 6.5 1h7A1.5 1.5 0 0 1 15 2.5v7a1.5 1.5 0 0 1-1.5 1.5H12v1h1.5a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 13.5 0h-7A2.5 2.5 0 0 0 4 2.5V4z"/>
			<path d="M2.5 5A1.5 1.5 0 0 0 1 6.5v7A1.5 1.5 0 0 0 2.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 9.5 5h-7zM2 6.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7z"/>
		</svg>`;
	}

	private getRefreshIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3.011A6 6 0 0 1 13.5 5.5h-2a.5.5 0 0 0 0 1h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-1 0v1.686A7 7 0 0 0 1.063 7.5h1.012a6 6 0 0 1 2.606-4.489zM1 9.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 1 0v-1.686A7 7 0 0 0 14.937 8.5h-1.012a6 6 0 0 1-9.608 4.489A6 6 0 0 1 2.5 10.5h2a.5.5 0 0 0 0-1h-3a.5.5 0 0 0-.5.5z"/>
		</svg>`;
	}

	private getAddIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
		</svg>`;
	}

	private getCloseIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
		</svg>`;
	}

	private getSpinnerIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1a7 7 0 1 0 7 7h-1A6 6 0 1 1 8 2V1z"/>
		</svg>`;
	}
}
