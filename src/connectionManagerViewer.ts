import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient, DatabaseSchemaIndex } from './kustoClient';

const VIEW_TITLE = 'Connection Manager';

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
	leaveNoTraceClusters: string[];
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
	| { type: 'openInEditor'; connectionId: string; database?: string }
	| { type: 'leaveNoTrace.add'; clusterUrl: string }
	| { type: 'leaveNoTrace.remove'; clusterUrl: string };

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
		const leaveNoTraceClusters = this.connectionManager.getLeaveNoTraceClusters();

		return {
			timestamp: Date.now(),
			connections,
			favorites,
			cachedDatabases,
			expandedClusters,
			leaveNoTraceClusters
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

			case 'leaveNoTrace.add': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				if (!clusterUrl) {
					return;
				}

				try {
					await this.connectionManager.addLeaveNoTrace(clusterUrl);
					// Send updated snapshot so UI reflects the change
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
					void vscode.window.setStatusBarMessage('Cluster marked as "Leave no trace"', 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to mark cluster: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			case 'leaveNoTrace.remove': {
				const clusterUrl = String(msg.clusterUrl || '').trim();
				if (!clusterUrl) {
					return;
				}

				try {
					await this.connectionManager.removeLeaveNoTrace(clusterUrl);
					// Send updated snapshot so UI reflects the change
					const snapshot = await this.buildSnapshot();
					this.panel.webview.postMessage({ type: 'snapshot', snapshot });
					void vscode.window.setStatusBarMessage('Cluster removed from "Leave no trace"', 2000);
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to remove cluster from "Leave no trace": ${error instanceof Error ? error.message : String(error)}`);
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
			display: flex;
			height: calc(100vh - 80px);
			position: relative;
		}

		.left-panel {
			width: 280px;
			min-width: 200px;
			max-width: 500px;
			height: 100%;
			display: flex;
			flex-direction: column;
			flex-shrink: 0;
			transition: width 0.15s ease, min-width 0.15s ease, opacity 0.15s ease;
			overflow: hidden;
			margin-right: 8px;
		}

		.left-panel.collapsed {
			width: 0 !important;
			min-width: 0 !important;
			opacity: 0;
			pointer-events: none;
			margin-right: 0;
		}

		.splitter {
			width: 6px;
			cursor: col-resize;
			background: transparent;
			transition: background 0.1s;
			position: relative;
			flex-shrink: 0;
			margin-right: 8px;
		}

		.splitter::after {
			content: '';
			position: absolute;
			top: 0;
			bottom: 0;
			left: 2px;
			width: 2px;
			background: transparent;
			transition: background 0.1s;
		}

		.splitter:hover::after,
		.splitter.dragging::after {
			background: var(--vscode-focusBorder);
		}

		.splitter-collapse-btn {
			position: absolute;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			width: 18px;
			height: 32px;
			background: var(--vscode-editorWidget-background);
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 3px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			opacity: 0;
			transition: opacity 0.15s, background 0.1s;
			z-index: 5;
		}

		.splitter:hover .splitter-collapse-btn,
		.splitter-collapse-btn:hover {
			opacity: 1;
		}

		.splitter-collapse-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.splitter-collapse-btn svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
			transform: rotate(180deg);
		}

		.splitter.collapsed {
			width: 0;
			pointer-events: none;
			margin-right: 0;
		}

		.right-panel {
			flex: 1;
			min-width: 300px;
			display: flex;
			flex-direction: column;
			transition: margin-left 0.15s ease;
		}

		.left-panel.collapsed ~ .splitter.collapsed ~ .right-panel {
			margin-left: 28px;
		}

		/* Panel toggle button */
		.panel-toggle {
			position: absolute;
			left: 0;
			top: 50%;
			transform: translateY(-50%);
			width: 20px;
			height: 48px;
			background: var(--vscode-editorWidget-background);
			border: 1px solid var(--vscode-editorWidget-border);
			border-left: none;
			border-radius: 0 4px 4px 0;
			cursor: pointer;
			display: none;
			align-items: center;
			justify-content: center;
			transition: background 0.1s, opacity 0.15s;
			z-index: 10;
		}

		.panel-toggle:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.panel-toggle svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
			transition: transform 0.15s;
		}

		.left-panel.collapsed ~ .panel-toggle {
			display: flex;
		}

		/* Left panel accordion */
		.left-accordion {
			border: 1px solid var(--vscode-editorWidget-border);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
			display: flex;
			flex-direction: column;
			max-height: 100%;
			min-height: 0;
		}

		.left-accordion-item {
			display: flex;
			flex-direction: column;
			flex-shrink: 0;
		}

		.left-accordion-item:not(:last-child) {
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.left-accordion-item.expanded {
			/* Allow shrinking when space is limited, enabling scroll */
			flex-shrink: 1;
			min-height: 0;
			overflow: hidden;
		}

		.left-accordion-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			height: 42px;
			box-sizing: border-box;
			cursor: pointer;
			user-select: none;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			transition: background 0.1s;
			flex-shrink: 0;
		}

		.left-accordion-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.left-accordion-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
		}

		.left-accordion-icon svg {
			width: 16px;
			height: 16px;
			fill: currentColor;
		}

		.left-accordion-icon.star {
			color: #f5c518;
		}

		.left-accordion-title {
			flex: 1;
			font-weight: 600;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.left-accordion-count {
			font-size: 11px;
			font-weight: 500;
			color: var(--vscode-descriptionForeground);
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 2px 6px;
			border-radius: 10px;
			min-width: 18px;
			text-align: center;
		}

		.left-accordion-chevron {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
			transition: transform 0.15s ease;
			opacity: 0.7;
		}

		.left-accordion-chevron svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
		}

		.left-accordion-header:hover .left-accordion-chevron {
			opacity: 1;
		}

		.left-accordion-chevron.expanded {
			transform: rotate(90deg);
		}

		.left-accordion-body {
			display: none;
		}

		.left-accordion-body.expanded {
			display: block;
			overflow-y: auto;
			/* Don't force flex growth - let content determine size, scroll only when needed */
			min-height: 0;
		}

		/* Keep old section styles for right panel */
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
			padding: 8px 12px;
			height: 42px;
			box-sizing: border-box;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}

		.section-title {
			font-weight: 600;
			font-size: 13px;
		}

		.section-body {
			padding: 12px 14px;
			overflow-y: auto;
			flex: 1;
		}

		/* Explorer section special handling */
		.right-panel .section {
			display: flex;
			flex-direction: column;
			height: 100%;
		}

		.right-panel .section-body {
			padding: 0;
			overflow-y: auto;
			flex: 1;
		}

		.left-panel .section {
			flex-shrink: 0;
		}

		.left-panel #connectionsSection {
			flex: 1;
			display: flex;
			flex-direction: column;
			min-height: 0;
		}

		.left-panel #connectionsSection .section-body {
			flex: 1;
			overflow-y: auto;
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
			padding: 6px 12px;
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
			gap: 0;
		}

		.connection-name {
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-right: 4px;
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
			flex-shrink: 0;
		}

		.connection-actions .btn-icon {
			opacity: 0;
			transition: opacity 0.1s;
		}

		.connection-item:hover .connection-actions .btn-icon {
			opacity: 1;
		}

		/* Leave No Trace active button - always visible when active */
		.connection-actions .btn-icon.lnt-active {
			opacity: 1;
		}

		/* Leave No Trace icon in the LNT section */
		.lnt-icon {
			color: var(--vscode-symbolIcon-eventForeground, #d19a66);
			display: flex;
			align-items: center;
			flex-shrink: 0;
			margin-right: 6px;
		}

		.lnt-icon svg {
			width: 14px;
			height: 14px;
		}

		/* Favorites section */
		.favorites-section {
			margin-bottom: 16px;
		}

		.favorite-item {
			display: flex;
			flex-direction: column;
			padding: 6px 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			cursor: pointer;
			transition: background 0.1s;
		}

		.favorite-item:last-child {
			border-bottom: none;
		}

		.favorite-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.favorite-row {
			display: flex;
			align-items: center;
			gap: 0;
		}

		.favorite-name {
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-right: 4px;
		}

		.favorite-detail {
			font-size: 11px;
			opacity: 0.7;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-top: 2px;
		}

		.favorite-actions {
			display: flex;
			gap: 2px;
			opacity: 0;
			transition: opacity 0.1s;
			flex-shrink: 0;
		}

		.favorite-item:hover .favorite-actions {
			opacity: 1;
		}

		/* Breadcrumb navigation */
		.explorer-breadcrumb {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 8px 12px;
			font-size: 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-sideBar-background);
			flex-wrap: wrap;
		}

		.breadcrumb-item {
			display: flex;
			align-items: center;
			gap: 4px;
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
			padding: 2px 4px;
			border-radius: 3px;
			transition: background 0.1s;
		}

		.breadcrumb-item:hover {
			background: var(--vscode-list-hoverBackground);
			text-decoration: underline;
		}

		.breadcrumb-item.current {
			color: var(--vscode-foreground);
			cursor: default;
			font-weight: 500;
		}

		.breadcrumb-item.current:hover {
			background: transparent;
			text-decoration: none;
		}

		.breadcrumb-separator {
			color: var(--vscode-descriptionForeground);
			opacity: 0.6;
		}

		.breadcrumb-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.breadcrumb-icon svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
		}

		/* Explorer list items */
		.explorer-list {
			flex: 1;
			overflow-y: auto;
		}

		.explorer-list-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 10px 12px;
			cursor: pointer;
			transition: background 0.1s;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.explorer-list-item:last-child {
			border-bottom: none;
		}

		.explorer-list-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.explorer-list-item-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
		}

		.explorer-list-item-icon svg {
			width: 16px;
			height: 16px;
			fill: currentColor;
		}

		.explorer-list-item-icon.cluster { color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
		.explorer-list-item-icon.database { color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
		.explorer-list-item-icon.table { color: var(--vscode-symbolIcon-structForeground, #00bcb4); }
		.explorer-list-item-icon.function { color: var(--vscode-symbolIcon-methodForeground, #b180d7); }
		.explorer-list-item-icon.folder { color: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
		.explorer-list-item-icon.column { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }

		.explorer-list-item-name {
			flex-shrink: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 100%;
		}

		.explorer-list-item-meta {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			flex-shrink: 0;
		}

		/* Function signature - hidden by default, shown on hover */
		.explorer-list-item-params {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			opacity: 0;
			transition: opacity 0.15s;
			flex-shrink: 1;
			overflow: hidden;
			min-width: 0;
		}

		.function-item-row {
			overflow: hidden;
		}

		.function-item-row:hover .explorer-list-item-params {
			opacity: 1;
		}

		.function-item-row:hover .explorer-list-item-name {
			flex-shrink: 1;
			min-width: 60px;
		}

		.explorer-list-item-actions {
			display: flex;
			gap: 2px;
			flex-shrink: 0;
		}

		.explorer-list-item-actions .btn-icon {
			opacity: 0;
			transition: opacity 0.1s;
		}

		.explorer-list-item:hover .explorer-list-item-actions .btn-icon {
			opacity: 1;
		}

		/* Favorite button - always visible when active */
		.explorer-list-item-actions .btn-icon.is-favorite {
			opacity: 1;
		}

		/* Explorer accordion */
		.explorer-cluster-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-sideBar-background);
			position: sticky;
			top: 0;
			z-index: 1;
		}

		.explorer-db-header {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			background: var(--vscode-sideBar-background);
			position: sticky;
			top: 0;
			z-index: 1;
		}

		.explorer-back-btn {
			margin-right: 4px;
		}

		.explorer-back-btn svg {
			width: 14px;
			height: 14px;
		}

		.database-row {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 10px 12px;
			cursor: pointer;
			transition: background 0.1s;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.database-row:last-child {
			border-bottom: none;
		}

		.database-row:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.database-row .accordion-title {
			flex: 1;
		}

		.database-row .accordion-actions {
			opacity: 0;
			transition: opacity 0.1s;
		}

		.database-row:hover .accordion-actions {
			opacity: 1;
		}

		.accordion {
			font-size: 13px;
			flex: 1;
			overflow-y: auto;
		}

		.accordion-item {
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.accordion-item:last-child {
			border-bottom: none;
		}

		.accordion-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 10px;
			cursor: pointer;
			user-select: none;
			transition: background 0.1s;
		}

		.accordion-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.accordion-header.expanded {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		.accordion-chevron {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
			transition: transform 0.15s ease;
			opacity: 0.7;
		}

		.accordion-chevron svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
		}

		.accordion-header:hover .accordion-chevron {
			opacity: 1;
		}

		.accordion-chevron.expanded {
			transform: rotate(90deg);
		}

		.accordion-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
		}

		.accordion-icon svg {
			width: 14px;
			height: 14px;
			fill: currentColor;
		}

		.accordion-icon.database svg { fill: var(--vscode-symbolIcon-namespaceForeground, #6c71c4); }
		.accordion-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #2aa198); }
		.accordion-icon.function svg { fill: var(--vscode-symbolIcon-functionForeground, #859900); }
		.accordion-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #b58900); }

		.accordion-title {
			flex: 1;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.accordion-badge {
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 10px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			flex-shrink: 0;
		}

		.accordion-actions {
			display: flex;
			gap: 2px;
			opacity: 0;
			transition: opacity 0.1s;
			flex-shrink: 0;
		}

		.accordion-header:hover .accordion-actions {
			opacity: 1;
		}

		.accordion-body {
			display: none;
		}

		.accordion-body.expanded {
			display: block;
		}

		/* Expandable item wrapper */
		.explorer-list-item-wrapper {
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.explorer-list-item-wrapper:last-child {
			border-bottom: none;
		}

		.explorer-list-item-wrapper .explorer-list-item {
			border-bottom: none;
		}

		.explorer-list-item-wrapper.expanded {
			background: var(--vscode-list-hoverBackground);
		}

		.explorer-list-item-chevron {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
			transition: transform 0.15s ease;
			opacity: 0.7;
		}

		.explorer-list-item-chevron svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.explorer-list-item:hover .explorer-list-item-chevron {
			opacity: 1;
		}

		.explorer-list-item-chevron.expanded {
			transform: rotate(90deg);
		}

		/* Expanded item details */
		.explorer-item-details {
			padding: 8px 12px 12px 44px;
			background: var(--vscode-editorWidget-background);
			border-top: 1px solid var(--vscode-editorWidget-border);
		}

		.explorer-detail-section {
			margin-bottom: 12px;
		}

		.explorer-detail-section:last-child {
			margin-bottom: 0;
		}

		.explorer-detail-label {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 4px;
		}

		.explorer-detail-docstring {
			font-size: 12px;
			color: var(--vscode-editor-foreground);
			line-height: 1.4;
			white-space: pre-wrap;
			word-wrap: break-word;
		}

		.explorer-detail-code {
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			color: var(--vscode-symbolIcon-methodForeground, #b180d7);
			padding: 4px 8px;
			background: rgba(0, 0, 0, 0.1);
			border-radius: 4px;
		}

		.explorer-detail-body {
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 11px;
			line-height: 1.4;
			color: var(--vscode-editor-foreground);
			background: rgba(0, 0, 0, 0.15);
			border-radius: 4px;
			padding: 8px 10px;
			margin: 0;
			white-space: pre-wrap;
			word-wrap: break-word;
			max-height: 200px;
			overflow-y: auto;
		}

		.explorer-detail-schema {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}

		.explorer-schema-row {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 3px 8px;
			font-size: 11px;
			background: rgba(0, 0, 0, 0.08);
			border-radius: 3px;
		}

		.explorer-schema-row:hover {
			background: rgba(0, 0, 0, 0.15);
		}

		.explorer-schema-col-name {
			font-family: var(--vscode-editor-font-family, monospace);
			color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.explorer-schema-col-type {
			font-family: var(--vscode-editor-font-family, monospace);
			color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0);
			font-size: 10px;
			flex-shrink: 0;
		}

		.explorer-schema-col-doc {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
			opacity: 0.6;
			cursor: help;
		}

		.explorer-schema-col-doc svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.explorer-schema-col-doc:hover {
			opacity: 1;
		}

		/* Sub-accordion (Tables/Functions level) */
		.sub-accordion {
			border-top: 1px solid var(--vscode-editorWidget-border);
		}

		.sub-accordion-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 8px 12px;
			cursor: pointer;
			user-select: none;
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.3px;
			opacity: 0.8;
			transition: background 0.1s, opacity 0.1s;
		}

		.sub-accordion-header:hover {
			background: var(--vscode-list-hoverBackground);
			opacity: 1;
		}

		.sub-accordion-chevron {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
			transition: transform 0.15s ease;
		}

		.sub-accordion-chevron svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.sub-accordion-chevron.expanded {
			transform: rotate(90deg);
		}

		.sub-accordion-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.sub-accordion-icon svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.sub-accordion-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #b58900); }
		.sub-accordion-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #2aa198); }
		.sub-accordion-icon.function svg { fill: var(--vscode-symbolIcon-functionForeground, #859900); }

		.sub-accordion-title {
			flex: 1;
			font-weight: 600;
		}

		.sub-accordion-badge {
			font-size: 9px;
			padding: 1px 5px;
			border-radius: 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}

		.sub-accordion-body {
			display: none;
			padding: 4px 0;
		}

		.sub-accordion-body.expanded {
			display: block;
		}

		/* Item list (tables/functions) */
		.item-list {
			list-style: none;
			margin: 0;
			padding: 0;
		}

		.item-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 3px 12px 3px 24px;
			cursor: pointer;
			font-size: 12px;
			transition: background 0.1s;
		}

		.item-row:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.item-row.nested {
			padding-left: 36px;
		}

		.item-row.nested-2 {
			padding-left: 48px;
		}

		.item-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.item-icon svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.item-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #2aa198); }
		.item-icon.function svg { fill: var(--vscode-symbolIcon-functionForeground, #859900); }
		.item-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #b58900); }

		.item-name {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.item-meta {
			font-size: 10px;
			opacity: 0.6;
			flex-shrink: 0;
		}

		.item-params {
			font-size: 11px;
			opacity: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			transition: opacity 0.15s;
			color: var(--vscode-descriptionForeground);
			margin-left: 2px;
		}

		.item-row:hover .item-params {
			opacity: 0.6;
		}

		/* Nested accordion for folders */
		.nested-accordion {
			border-left: 2px solid var(--vscode-symbolIcon-folderForeground, #b58900);
		}

		.nested-accordion-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 8px 10px;
			cursor: pointer;
			user-select: none;
			font-size: 12px;
			font-weight: 500;
			background: rgba(128, 128, 128, 0.1);
			transition: background 0.1s;
		}

		.nested-accordion-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.nested-accordion-chevron {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
			transition: transform 0.15s ease;
			opacity: 0.7;
		}

		.nested-accordion-chevron svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.nested-accordion-chevron.expanded {
			transform: rotate(90deg);
		}

		.nested-accordion-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.nested-accordion-icon svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.nested-accordion-icon.folder svg { fill: var(--vscode-symbolIcon-folderForeground, #b58900); }

		.nested-accordion-title {
			flex: 1;
		}

		.nested-accordion-body {
			display: none;
		}

		.nested-accordion-body.expanded {
			display: block;
		}

		/* Table accordion (expandable to show columns) */
		.table-accordion {
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.table-accordion:last-child {
			border-bottom: none;
		}

		.table-accordion-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 7px 10px;
			cursor: pointer;
			font-size: 12px;
			transition: background 0.1s;
		}

		.table-accordion-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.table-accordion-chevron {
			width: 12px;
			height: 12px;
			flex-shrink: 0;
			transition: transform 0.1s;
			opacity: 0.5;
		}

		.table-accordion-chevron svg {
			width: 10px;
			height: 10px;
			fill: currentColor;
		}

		.table-accordion-chevron.expanded {
			transform: rotate(90deg);
			opacity: 0.8;
		}

		.table-accordion-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.table-accordion-icon svg {
			width: 12px;
			height: 12px;
			fill: currentColor;
		}

		.table-accordion-icon.table svg { fill: var(--vscode-symbolIcon-structForeground, #2aa198); }

		.table-accordion-name {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.table-accordion-meta {
			font-size: 10px;
			opacity: 0.6;
			flex-shrink: 0;
		}

		.table-accordion-body {
			display: none;
			padding: 4px 0;
			background: rgba(0, 0, 0, 0.1);
		}

		.table-accordion-body.expanded {
			display: block;
		}

		.column-row {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 5px 10px 5px 32px;
			font-size: 11px;
		}

		.column-row:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.column-name {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.column-type {
			font-size: 10px;
			opacity: 0.6;
			font-family: var(--vscode-editor-font-family, monospace);
			flex-shrink: 0;
		}

		/* Function item */
		.function-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 7px 10px;
			font-size: 12px;
			cursor: pointer;
			transition: background 0.1s;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
		}

		.function-item:last-child {
			border-bottom: none;
		}

		.function-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.function-item-icon {
			width: 14px;
			height: 14px;
			flex-shrink: 0;
		}

		.function-item-icon svg {
			width: 12px;
			height: 12px;
			fill: var(--vscode-symbolIcon-functionForeground, #859900);
		}

		.function-item-name {
			white-space: nowrap;
		}

		.function-item-params {
			font-size: 11px;
			opacity: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			transition: opacity 0.15s;
			color: var(--vscode-descriptionForeground);
		}

		.function-item:hover .function-item-params {
			opacity: 0.6;
		}

		/* Keep tree styles for backward compat */
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
		<div class="left-panel" id="leftPanel">
			<div class="left-accordion">
				<!-- Favorites -->
				<div class="left-accordion-item" id="favoritesSection" data-accordion-item="favorites" style="display: none;">
					<div class="left-accordion-header" data-toggle-accordion="favorites">
						<span class="left-accordion-chevron">${this.getChevronIcon()}</span>
						<span class="left-accordion-icon star">${this.getStarFilledIcon()}</span>
						<span class="left-accordion-title">Favorites</span>
						<span class="left-accordion-count" id="favoritesCount">0</span>
					</div>
					<div class="left-accordion-body" id="favoritesList"></div>
				</div>

				<!-- Clusters -->
				<div class="left-accordion-item expanded" id="connectionsSection" data-accordion-item="connections">
					<div class="left-accordion-header" data-toggle-accordion="connections">
						<span class="left-accordion-chevron expanded">${this.getChevronIcon()}</span>
						<span class="left-accordion-icon">${this.getClusterIcon()}</span>
						<span class="left-accordion-title">Clusters</span>
						<button class="btn-icon header-action" id="addConnectionBtn" title="Add new cluster">
							${this.getAddIcon()}
						</button>
						<span class="left-accordion-count" id="clustersCount">0</span>
					</div>
					<div class="left-accordion-body expanded" id="connectionsList">
						<div class="empty-state">
							<div class="empty-state-icon">${this.getClusterIcon()}</div>
							<div class="empty-state-title">No clusters yet</div>
							<div class="empty-state-text">Add a Kusto cluster to get started.</div>
						</div>
					</div>
				</div>

				<!-- Leave No Trace -->
				<div class="left-accordion-item" id="leaveNoTraceSection" data-accordion-item="leaveNoTrace" style="display: none;">
					<div class="left-accordion-header" data-toggle-accordion="leaveNoTrace">
						<span class="left-accordion-chevron">${this.getChevronIcon()}</span>
						<span class="left-accordion-icon" style="color: var(--vscode-symbolIcon-eventForeground, #d19a66);">${this.getShieldIcon()}</span>
						<span class="left-accordion-title">Leave No Trace</span>
						<span class="left-accordion-count" id="leaveNoTraceCount">0</span>
					</div>
					<div class="left-accordion-body" id="leaveNoTraceList"></div>
				</div>
			</div>
		</div>

		<!-- Splitter -->
		<div class="splitter" id="splitter">
			<button class="splitter-collapse-btn" id="splitterCollapseBtn" title="Collapse sidebar">
				${this.getChevronIcon()}
			</button>
		</div>

		<!-- Panel Toggle (visible when collapsed) -->
		<div class="panel-toggle" id="panelToggle" title="Show sidebar">
			${this.getChevronIcon()}
		</div>

		<!-- Right Panel: Explorer & Details -->
		<div class="right-panel">
			<div class="section" style="height: 100%;">
				<div class="section-header" id="explorerHeader">
					<button class="btn-icon" id="toggleSidebarBtn" title="Toggle sidebar" style="margin-right: 4px;">
						${this.getSidebarIcon()}
					</button>
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
		var expandedTables = new Set(); // Track expanded tables (showing details)
		var expandedFunctions = new Set(); // Track expanded functions (showing details)
		var loadingDatabases = new Set();
		var databaseSchemas = {};
		// Navigation path for breadcrumb: { connectionId, database?, section?, folderPath? }
		// section can be 'tables' or 'functions'
		// folderPath is an array of folder names for nested folders
		var explorerPath = null;
		var sidebarCollapsed = false;
		var sidebarWidth = 280;

		// Splitter functionality
		(function() {
			var leftPanel = document.getElementById('leftPanel');
			var splitter = document.getElementById('splitter');
			var panelToggle = document.getElementById('panelToggle');
			var isDragging = false;
			var startX = 0;
			var startWidth = 0;

			function toggleSidebar() {
				sidebarCollapsed = !sidebarCollapsed;
				if (sidebarCollapsed) {
					leftPanel.classList.add('collapsed');
					splitter.classList.add('collapsed');
				} else {
					leftPanel.classList.remove('collapsed');
					splitter.classList.remove('collapsed');
				}
			}

			// Make toggleSidebar globally accessible for dynamic buttons
			window.toggleSidebar = toggleSidebar;

			splitter.addEventListener('mousedown', function(e) {
				if (sidebarCollapsed) return;
				isDragging = true;
				startX = e.clientX;
				startWidth = leftPanel.offsetWidth;
				splitter.classList.add('dragging');
				document.body.style.cursor = 'col-resize';
				document.body.style.userSelect = 'none';
				e.preventDefault();
			});

			document.addEventListener('mousemove', function(e) {
				if (!isDragging) return;
				var newWidth = startWidth + (e.clientX - startX);
				newWidth = Math.max(200, Math.min(500, newWidth));
				leftPanel.style.width = newWidth + 'px';
				sidebarWidth = newWidth;
			});

			document.addEventListener('mouseup', function() {
				if (isDragging) {
					isDragging = false;
					splitter.classList.remove('dragging');
					document.body.style.cursor = '';
					document.body.style.userSelect = '';
				}
			});

			// Double-click to collapse
			splitter.addEventListener('dblclick', function() {
				toggleSidebar();
			});

			// Panel toggle button (when collapsed)
			panelToggle.addEventListener('click', function() {
				toggleSidebar();
			});

			// Splitter collapse button
			document.getElementById('splitterCollapseBtn').addEventListener('click', function(e) {
				e.stopPropagation();
				toggleSidebar();
			});

			// Use event delegation for dynamically created toggle button
			document.addEventListener('click', function(e) {
				if (e.target.closest('#toggleSidebarBtn')) {
					toggleSidebar();
				}
			});
		})();

		// Icons
		var ICONS = {
			cluster: '${this.escapeJs(this.getClusterIcon())}',
			database: '${this.escapeJs(this.getDatabaseIcon())}',
			table: '${this.escapeJs(this.getTableIcon())}',
			function: '${this.escapeJs(this.getFunctionIcon())}',
			column: '${this.escapeJs(this.getColumnIcon())}',
			folder: '${this.escapeJs(this.getFolderIcon())}',
			chevron: '${this.escapeJs(this.getChevronIcon())}',
			chevronRight: '${this.escapeJs(this.getChevronRightIcon())}',
			info: '${this.escapeJs(this.getInfoIcon())}',
			star: '${this.escapeJs(this.getStarIcon())}',
			starFilled: '${this.escapeJs(this.getStarFilledIcon())}',
			edit: '${this.escapeJs(this.getEditIcon())}',
			delete: '${this.escapeJs(this.getDeleteIcon())}',
			copy: '${this.escapeJs(this.getCopyIcon())}',
			refresh: '${this.escapeJs(this.getRefreshIcon())}',
			spinner: '${this.escapeJs(this.getSpinnerIcon())}',
			back: '${this.escapeJs(this.getBackIcon())}',
			sidebar: '${this.escapeJs(this.getSidebarIcon())}',
			shield: '${this.escapeJs(this.getShieldIcon())}'
		};

		// Helper to build header with toggle button
		function buildExplorerHeader(extraButtons) {
			return '<button class="btn-icon" id="toggleSidebarBtn" title="Toggle sidebar" style="margin-right: 4px;">' + ICONS.sidebar + '</button>' +
				(extraButtons || '') +
				'<span class="section-title">Cluster Explorer</span>';
		}

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
			var countEl = document.getElementById('favoritesCount');
			
			// Only show database favorites (filter out any cluster-only favorites)
			var dbFavorites = (lastSnapshot && lastSnapshot.favorites) 
				? lastSnapshot.favorites.filter(function(f) { return f.database && f.clusterUrl; })
				: [];
			
			// Update count
			if (countEl) countEl.textContent = dbFavorites.length;
			
			if (dbFavorites.length === 0) {
				section.style.display = 'none';
				return;
			}

			section.style.display = 'flex';
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

				html += '<div class="favorite-item" title="' + escapeHtml(displayName + ' — ' + detailLine) + '" data-fav-cluster="' + escapeHtml(fav.clusterUrl) + '" data-fav-db="' + escapeHtml(fav.database) + '"' + (conn ? ' data-fav-conn="' + escapeHtml(conn.id) + '"' : '') + '>';
				html += '<div class="favorite-row">';
				html += '<div class="favorite-name">' + escapeHtml(displayName) + '</div>';
				html += '<div class="favorite-actions">';
				html += '<button class="btn-icon" data-remove-fav-cluster="' + escapeHtml(fav.clusterUrl) + '" data-remove-fav-db="' + escapeHtml(fav.database) + '" title="Remove from favorites">' + ICONS.delete + '</button>';
				html += '</div>';
				html += '</div>';
				html += '<div class="favorite-detail">' + escapeHtml(detailLine) + '</div>';
				html += '</div>';
			});

			list.innerHTML = html;
		}

		function renderConnections() {
			var list = document.getElementById('connectionsList');
			var countEl = document.getElementById('clustersCount');
			var count = (lastSnapshot && lastSnapshot.connections) ? lastSnapshot.connections.length : 0;
			
			// Update count
			if (countEl) countEl.textContent = count;
			
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
				var isLnt = isLeaveNoTrace(conn.clusterUrl);
				html += '<li class="connection-item' + (isSelected ? ' selected' : '') + '" data-conn-id="' + escapeHtml(conn.id) + '">';
				html += '<div class="connection-row">';
				html += '<div class="connection-name">' + escapeHtml(conn.name) + '</div>';
				html += '<div class="connection-actions">';
				// Leave No Trace toggle button - always visible, styled as active when enabled
				if (isLnt) {
					html += '<button class="btn-icon lnt-active" data-remove-lnt="' + escapeHtml(conn.clusterUrl) + '" title="Remove from Leave No Trace" style="color: var(--vscode-symbolIcon-eventForeground, #d19a66); opacity: 1;">' + ICONS.shield + '</button>';
				} else {
					html += '<button class="btn-icon" data-add-lnt="' + escapeHtml(conn.clusterUrl) + '" title="Mark as Leave No Trace">' + ICONS.shield + '</button>';
				}
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

		function isLeaveNoTrace(clusterUrl) {
			if (!lastSnapshot || !lastSnapshot.leaveNoTraceClusters) return false;
			var normalized = normalizeClusterUrl(clusterUrl);
			return lastSnapshot.leaveNoTraceClusters.some(function(lntUrl) {
				return normalizeClusterUrl(lntUrl) === normalized;
			});
		}

		function renderLeaveNoTrace() {
			var section = document.getElementById('leaveNoTraceSection');
			var list = document.getElementById('leaveNoTraceList');
			var countEl = document.getElementById('leaveNoTraceCount');
			
			var lntClusters = (lastSnapshot && lastSnapshot.leaveNoTraceClusters) 
				? lastSnapshot.leaveNoTraceClusters
				: [];
			
			// Update count
			if (countEl) countEl.textContent = lntClusters.length;
			
			if (lntClusters.length === 0) {
				section.style.display = 'none';
				return;
			}

			section.style.display = 'flex';
			var html = '';

			lntClusters.forEach(function(lntUrl) {
				// Find connection name if available
				var connName = shortClusterName(lntUrl);
				if (lastSnapshot && lastSnapshot.connections) {
					var matchingConn = lastSnapshot.connections.find(function(c) {
						return normalizeClusterUrl(c.clusterUrl) === normalizeClusterUrl(lntUrl);
					});
					if (matchingConn) {
						connName = matchingConn.name;
					}
				}
				
				html += '<div class="favorite-item" data-lnt-url="' + escapeHtml(lntUrl) + '">';
				html += '<div class="favorite-row">';
				html += '<span class="lnt-icon">' + ICONS.shield + '</span>';
				html += '<span class="favorite-name">' + escapeHtml(connName) + '</span>';
				html += '<div class="favorite-actions">';
				html += '<button class="btn-icon" data-remove-lnt="' + escapeHtml(lntUrl) + '" title="Remove from Leave No Trace">' + ICONS.delete + '</button>';
				html += '</div>';
				html += '</div>';
				html += '<div class="favorite-detail">' + escapeHtml(lntUrl) + '</div>';
				html += '</div>';
			});

			list.innerHTML = html;
		}

		function renderExplorer() {
			var content = document.getElementById('explorerContent');
			var header = document.getElementById('explorerHeader');
			
			if (!selectedConnectionId || !lastSnapshot) {
				header.innerHTML = buildExplorerHeader();
				content.innerHTML = '<div class="empty-state">' +
					'<div class="empty-state-icon">' + ICONS.database + '</div>' +
					'<div class="empty-state-title">Select a cluster</div>' +
					'<div class="empty-state-text">Click on a cluster to explore its databases, tables, and functions.</div>' +
					'</div>';
				return;
			}

			var conn = lastSnapshot.connections.find(function(c) { return c.id === selectedConnectionId; });
			if (!conn) {
				header.innerHTML = buildExplorerHeader();
				content.innerHTML = '<div class="empty-state">Cluster not found</div>';
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

			header.innerHTML = buildExplorerHeader();

			// Helper to build folder tree
			function buildFolderTree(items, getFolderFn) {
				var tree = { __items: [] };
				items.forEach(function(item) {
					var folder = getFolderFn(item);
					if (folder) {
						var parts = folder.split('/').filter(function(p) { return p; });
						var node = tree;
						parts.forEach(function(part) {
							if (!node[part]) node[part] = { __items: [] };
							node = node[part];
						});
						node.__items.push(item);
					} else {
						tree.__items.push(item);
					}
				});
				return tree;
			}

			// Get items at a specific folder path within a tree
			function getTreeAtPath(tree, path) {
				var node = tree;
				for (var i = 0; i < path.length; i++) {
					if (node[path[i]]) {
						node = node[path[i]];
					} else {
						return { __items: [] };
					}
				}
				return node;
			}

			// Build breadcrumb HTML
			function buildBreadcrumb() {
				var html = '<div class="explorer-breadcrumb">';
				
				// Cluster (always shown, clickable to go back to databases)
				var isClusterCurrent = !explorerPath || !explorerPath.database;
				html += '<span class="breadcrumb-item' + (isClusterCurrent ? ' current' : '') + '" data-nav-to="cluster">';
				html += '<span class="breadcrumb-icon">' + ICONS.cluster + '</span>';
				html += escapeHtml(conn.name);
				html += '</span>';
				
				if (explorerPath && explorerPath.database) {
					html += '<span class="breadcrumb-separator">/</span>';
					var isDbCurrent = !explorerPath.section;
					html += '<span class="breadcrumb-item' + (isDbCurrent ? ' current' : '') + '" data-nav-to="database">';
					html += '<span class="breadcrumb-icon">' + ICONS.database + '</span>';
					html += escapeHtml(explorerPath.database);
					html += '</span>';
					
					if (explorerPath.section) {
						// Handle table-columns specially
						if (explorerPath.section === 'table-columns') {
							// Show Tables link
							html += '<span class="breadcrumb-separator">/</span>';
							html += '<span class="breadcrumb-item" data-nav-to="section" data-section-type="tables">';
							html += '<span class="breadcrumb-icon">' + ICONS.table + '</span>';
							html += 'Tables';
							html += '</span>';
							
							// Show folder path if any
							if (explorerPath.folderPath && explorerPath.folderPath.length > 0) {
								for (var i = 0; i < explorerPath.folderPath.length; i++) {
									html += '<span class="breadcrumb-separator">/</span>';
									html += '<span class="breadcrumb-item" data-nav-to="folder" data-folder-index="' + i + '">';
									html += '<span class="breadcrumb-icon">' + ICONS.folder + '</span>';
									html += escapeHtml(explorerPath.folderPath[i]);
									html += '</span>';
								}
							}
							
							// Show table name (current)
							html += '<span class="breadcrumb-separator">/</span>';
							html += '<span class="breadcrumb-item current">';
							html += '<span class="breadcrumb-icon">' + ICONS.table + '</span>';
							html += escapeHtml(explorerPath.tableName);
							html += '</span>';
						} else {
							// Normal section (tables/functions)
							html += '<span class="breadcrumb-separator">/</span>';
							var isSectionCurrent = !explorerPath.folderPath || explorerPath.folderPath.length === 0;
							var sectionIcon = explorerPath.section === 'tables' ? ICONS.table : ICONS.function;
							var sectionLabel = explorerPath.section === 'tables' ? 'Tables' : 'Functions';
							html += '<span class="breadcrumb-item' + (isSectionCurrent ? ' current' : '') + '" data-nav-to="section">';
							html += '<span class="breadcrumb-icon">' + sectionIcon + '</span>';
							html += escapeHtml(sectionLabel);
							html += '</span>';
							
							// Folder path
							if (explorerPath.folderPath && explorerPath.folderPath.length > 0) {
								for (var i = 0; i < explorerPath.folderPath.length; i++) {
									html += '<span class="breadcrumb-separator">/</span>';
									var isFolderCurrent = i === explorerPath.folderPath.length - 1;
									html += '<span class="breadcrumb-item' + (isFolderCurrent ? ' current' : '') + '" data-nav-to="folder" data-folder-index="' + i + '">';
									html += '<span class="breadcrumb-icon">' + ICONS.folder + '</span>';
									html += escapeHtml(explorerPath.folderPath[i]);
									html += '</span>';
								}
							}
						}
					}
				}
				
				html += '</div>';
				return html;
			}

			var html = '';
			
			// Add breadcrumb
			html += buildBreadcrumb();
			
			// Render based on current navigation level
			html += '<div class="explorer-list">';
			
			if (!explorerPath || !explorerPath.database) {
				// Level 1: Show databases
				if (isLoading) {
					html += '<div style="padding: 16px; text-align: center; opacity: 0.7;">' + ICONS.spinner + ' Loading databases...</div>';
				} else if (databases.length > 0) {
					databases.forEach(function(db) {
						var dbFav = isFavorite(conn.clusterUrl, db);
						html += '<div class="explorer-list-item" data-nav-database="' + escapeHtml(db) + '">';
						html += '<span class="explorer-list-item-icon database">' + ICONS.database + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(db) + '</span>';
						html += '<div class="explorer-list-item-actions">';
						html += '<button class="btn-icon' + (dbFav ? ' is-favorite' : '') + '" data-toggle-db-fav="' + escapeHtml(conn.id) + '" data-toggle-db-fav-cluster="' + escapeHtml(conn.clusterUrl) + '" data-toggle-db-fav-name="' + escapeHtml(conn.name) + '" data-db="' + escapeHtml(db) + '" title="' + (dbFav ? 'Remove from favorites' : 'Add to favorites') + '" style="color: ' + (dbFav ? '#f5c518' : 'inherit') + ';">' + (dbFav ? ICONS.starFilled : ICONS.star) + '</button>';
						html += '<button class="btn-icon" data-refresh-cluster="' + escapeHtml(conn.id) + '" title="Refresh">' + ICONS.refresh + '</button>';
						html += '</div>';
						html += '</div>';
					});
				} else {
					html += '<div class="empty-state">';
					html += '<div class="empty-state-text">No databases found.</div>';
					html += '<button class="btn" data-refresh-cluster="' + escapeHtml(conn.id) + '">Refresh</button>';
					html += '</div>';
				}
			} else if (!explorerPath.section) {
				// Level 2: Show Tables/Functions for selected database
				var dbKey = conn.id + '|' + explorerPath.database;
				var schema = databaseSchemas[dbKey];
				
				if (!schema) {
					html += '<div style="padding: 16px; text-align: center; opacity: 0.7;">' + ICONS.spinner + ' Loading schema...</div>';
				} else {
					var tableCount = schema.tables ? schema.tables.length : 0;
					var fnCount = schema.functions ? schema.functions.length : 0;
					
					if (tableCount > 0) {
						html += '<div class="explorer-list-item" data-nav-section="tables">';
						html += '<span class="explorer-list-item-icon table">' + ICONS.table + '</span>';
						html += '<span class="explorer-list-item-name">Tables</span>';
						html += '<span class="explorer-list-item-meta">' + tableCount + '</span>';
						html += '</div>';
					}
					
					if (fnCount > 0) {
						html += '<div class="explorer-list-item" data-nav-section="functions">';
						html += '<span class="explorer-list-item-icon function">' + ICONS.function + '</span>';
						html += '<span class="explorer-list-item-name">Functions</span>';
						html += '<span class="explorer-list-item-meta">' + fnCount + '</span>';
						html += '</div>';
					}
					
					if (tableCount === 0 && fnCount === 0) {
						html += '<div class="empty-state"><div class="empty-state-text">No tables or functions found.</div></div>';
					}
				}
			} else {
				// Level 3+: Show tables/functions/folders
				var dbKey = conn.id + '|' + explorerPath.database;
				var schema = databaseSchemas[dbKey];
				
				if (!schema) {
					html += '<div style="padding: 16px; text-align: center; opacity: 0.7;">' + ICONS.spinner + ' Loading schema...</div>';
				} else if (explorerPath.section === 'tables') {
					var tableFolders = schema.tableFolders || {};
					var tableTree = buildFolderTree(schema.tables || [], function(t) { return tableFolders[t]; });
					var currentNode = getTreeAtPath(tableTree, explorerPath.folderPath || []);
					
					// Get subfolders and items at current level
					var folders = Object.keys(currentNode).filter(function(k) { return k !== '__items'; }).sort();
					var tables = currentNode.__items || [];
					
					// Render folders first
					folders.forEach(function(folderName) {
						html += '<div class="explorer-list-item" data-nav-folder="' + escapeHtml(folderName) + '">';
						html += '<span class="explorer-list-item-icon folder">' + ICONS.folder + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(folderName) + '</span>';
						html += '</div>';
					});
					
					// Render tables with expandable details
					tables.forEach(function(table) {
						var cols = schema.columnTypesByTable[table] || {};
						var colNames = Object.keys(cols).sort();
						var colCount = colNames.length;
						var tableKey = dbKey + '|table|' + table;
						var isExpanded = expandedTables.has(tableKey);
						var tableDocString = schema.tableDocStrings ? schema.tableDocStrings[table] : null;
						
						html += '<div class="explorer-list-item-wrapper' + (isExpanded ? ' expanded' : '') + '">';
						html += '<div class="explorer-list-item" data-toggle-table="' + escapeHtml(tableKey) + '" data-table-name="' + escapeHtml(table) + '">';
						html += '<span class="explorer-list-item-chevron' + (isExpanded ? ' expanded' : '') + '">' + ICONS.chevronRight + '</span>';
						html += '<span class="explorer-list-item-icon table">' + ICONS.table + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(table) + '</span>';
						if (colCount > 0) html += '<span class="explorer-list-item-meta">' + colCount + ' cols</span>';
						html += '</div>';
						
						// Render expanded details
						if (isExpanded) {
							html += '<div class="explorer-item-details">';
							
							// DocString section
							if (tableDocString) {
								html += '<div class="explorer-detail-section">';
								html += '<div class="explorer-detail-label">Description</div>';
								html += '<div class="explorer-detail-docstring">' + escapeHtml(tableDocString) + '</div>';
								html += '</div>';
							}
							
							// Schema section (columns with types)
							if (colCount > 0) {
								html += '<div class="explorer-detail-section">';
								html += '<div class="explorer-detail-label">Schema (' + colCount + ' columns)</div>';
								html += '<div class="explorer-detail-schema">';
								colNames.forEach(function(colName) {
									var colType = cols[colName] || '';
									var colDocKey = table + '.' + colName;
									var colDocString = schema.columnDocStrings ? schema.columnDocStrings[colDocKey] : null;
									html += '<div class="explorer-schema-row">';
									html += '<span class="explorer-schema-col-name">' + escapeHtml(colName) + '</span>';
									html += '<span class="explorer-schema-col-type">' + escapeHtml(colType) + '</span>';
									if (colDocString) {
										html += '<span class="explorer-schema-col-doc" title="' + escapeHtml(colDocString) + '">' + ICONS.info + '</span>';
									}
									html += '</div>';
								});
								html += '</div>';
							}
							
							html += '</div>';
						}
						
						html += '</div>';
					});
					
					if (folders.length === 0 && tables.length === 0) {
						html += '<div class="empty-state"><div class="empty-state-text">No tables in this folder.</div></div>';
					}
				} else if (explorerPath.section === 'functions') {
					var fnTree = buildFolderTree(schema.functions || [], function(f) { return f.folder; });
					var currentNode = getTreeAtPath(fnTree, explorerPath.folderPath || []);
					
					var folders = Object.keys(currentNode).filter(function(k) { return k !== '__items'; }).sort();
					var functions = currentNode.__items || [];
					
					// Render folders first
					folders.forEach(function(folderName) {
						html += '<div class="explorer-list-item" data-nav-folder="' + escapeHtml(folderName) + '">';
						html += '<span class="explorer-list-item-icon folder">' + ICONS.folder + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(folderName) + '</span>';
						html += '</div>';
					});
					
					// Render functions with expandable details
					functions.forEach(function(fn) {
						var params = fn.parametersText || '';
						var fullSignature = fn.name + (params ? '(' + params + ')' : '');
						var fnKey = dbKey + '|fn|' + fn.name;
						var isExpanded = expandedFunctions.has(fnKey);
						
						html += '<div class="explorer-list-item-wrapper' + (isExpanded ? ' expanded' : '') + '">';
						html += '<div class="explorer-list-item function-item-row" data-toggle-function="' + escapeHtml(fnKey) + '" data-fn-name="' + escapeHtml(fn.name) + '" title="' + escapeHtml(fullSignature) + '">';
						html += '<span class="explorer-list-item-chevron' + (isExpanded ? ' expanded' : '') + '">' + ICONS.chevronRight + '</span>';
						html += '<span class="explorer-list-item-icon function">' + ICONS.function + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(fn.name) + '</span>';
						if (params) html += '<span class="explorer-list-item-params">(' + escapeHtml(params) + ')</span>';
						html += '</div>';
						
						// Render expanded details
						if (isExpanded) {
							html += '<div class="explorer-item-details">';
							
							// DocString section
							if (fn.docString) {
								html += '<div class="explorer-detail-section">';
								html += '<div class="explorer-detail-label">Description</div>';
								html += '<div class="explorer-detail-docstring">' + escapeHtml(fn.docString) + '</div>';
								html += '</div>';
							}
							
							// Full signature
							html += '<div class="explorer-detail-section">';
							html += '<div class="explorer-detail-label">Signature</div>';
							html += '<div class="explorer-detail-code">' + escapeHtml(fn.name + (params || '()')) + '</div>';
							html += '</div>';
							
							// Body section
							if (fn.body) {
								html += '<div class="explorer-detail-section">';
								html += '<div class="explorer-detail-label">Implementation</div>';
								html += '<pre class="explorer-detail-body">' + escapeHtml(fn.body) + '</pre>';
								html += '</div>';
							}
							
							html += '</div>';
						}
						
						html += '</div>';
					});
					
					if (folders.length === 0 && functions.length === 0) {
						html += '<div class="empty-state"><div class="empty-state-text">No functions in this folder.</div></div>';
					}
				} else if (explorerPath.section === 'table-columns') {
					// Show columns for a specific table (legacy view - keeping for backwards compat)
					var tableName = explorerPath.tableName;
					var cols = schema.columnTypesByTable[tableName] || {};
					var colNames = Object.keys(cols).sort();
					
					colNames.forEach(function(colName) {
						var colType = cols[colName] || '';
						html += '<div class="explorer-list-item">';
						html += '<span class="explorer-list-item-icon column">' + ICONS.column + '</span>';
						html += '<span class="explorer-list-item-name">' + escapeHtml(colName) + '</span>';
						if (colType) html += '<span class="explorer-list-item-meta">' + escapeHtml(colType) + '</span>';
						html += '</div>';
					});
					
					if (colNames.length === 0) {
						html += '<div class="empty-state"><div class="empty-state-text">No columns found.</div></div>';
					}
				}
			}
			
			html += '</div>';
			content.innerHTML = html;
		}

		function renderAll() {
			renderFavorites();
			renderConnections();
			renderLeaveNoTrace();
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

		// Left panel accordion toggle
		var expandedAccordion = 'connections'; // Connections expanded by default
		
		function setAccordionState(itemName, isExpanded) {
			var item = document.querySelector('[data-accordion-item="' + itemName + '"]');
			if (!item) {
				console.log('Accordion item not found:', itemName);
				return;
			}
			var chevron = item.querySelector('.left-accordion-chevron');
			var body = item.querySelector('.left-accordion-body');
			
			if (isExpanded) {
				item.classList.add('expanded');
				chevron.classList.add('expanded');
				body.classList.add('expanded');
				// Remove any inline style so CSS class takes over
				body.style.removeProperty('display');
			} else {
				item.classList.remove('expanded');
				chevron.classList.remove('expanded');
				body.classList.remove('expanded');
				// Remove any inline style so CSS class takes over
				body.style.removeProperty('display');
			}
		}
		
		document.querySelectorAll('[data-toggle-accordion]').forEach(function(header) {
			header.addEventListener('click', function(e) {
				// Don't toggle if clicking a button inside the header
				if (e.target.closest('.btn') || e.target.closest('.btn-icon')) return;
				
				var itemName = header.getAttribute('data-toggle-accordion');
				console.log('Accordion clicked:', itemName, 'current expanded:', expandedAccordion);
				
				if (expandedAccordion === itemName) {
					// Already expanded, do nothing (always keep one open)
					return;
				}
				
				// Collapse the currently expanded one
				if (expandedAccordion) {
					setAccordionState(expandedAccordion, false);
				}
				
				// Expand the clicked one
				expandedAccordion = itemName;
				setAccordionState(itemName, true);
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
					// Clear navigation path when switching clusters
					if (selectedConnectionId !== connId) {
						explorerPath = null;
					}
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

			// Add Leave No Trace
			var addLnt = closest(target, '[data-add-lnt]');
			if (addLnt) {
				var clusterUrl = addLnt.getAttribute('data-add-lnt');
				vscode.postMessage({ type: 'leaveNoTrace.add', clusterUrl: clusterUrl });
				return;
			}

			// Remove Leave No Trace
			var removeLnt = closest(target, '[data-remove-lnt]');
			if (removeLnt) {
				var clusterUrl = removeLnt.getAttribute('data-remove-lnt');
				vscode.postMessage({ type: 'leaveNoTrace.remove', clusterUrl: clusterUrl });
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

			// Toggle table expand/collapse (show columns)
			var expandTable = closest(target, '[data-expand-table]');
			if (expandTable) {
				var tableKey = expandTable.getAttribute('data-expand-table');
				if (expandedFolders.has(tableKey)) {
					expandedFolders.delete(tableKey);
				} else {
					expandedFolders.add(tableKey);
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

			// Back button in explorer header (removed - using breadcrumbs now)
			
			// Breadcrumb navigation
			var navTo = closest(target, '[data-nav-to]');
			if (navTo) {
				var navType = navTo.getAttribute('data-nav-to');
				if (navType === 'cluster') {
					explorerPath = null;
				} else if (navType === 'database') {
					explorerPath = { connectionId: selectedConnectionId, database: explorerPath.database };
				} else if (navType === 'section') {
					// Handle navigating from table-columns back to tables
					var sectionType = navTo.getAttribute('data-section-type');
					var section = sectionType || explorerPath.section;
					if (section === 'table-columns') section = 'tables';
					explorerPath = { connectionId: selectedConnectionId, database: explorerPath.database, section: section, folderPath: [] };
				} else if (navType === 'folder') {
					var folderIndex = parseInt(navTo.getAttribute('data-folder-index'), 10);
					// When navigating from table-columns, go back to tables section
					var section = explorerPath.section === 'table-columns' ? 'tables' : explorerPath.section;
					explorerPath = { 
						connectionId: selectedConnectionId, 
						database: explorerPath.database, 
						section: section, 
						folderPath: explorerPath.folderPath.slice(0, folderIndex + 1) 
					};
				}
				renderExplorer();
				return;
			}
			
			// Navigate to database
			var navDatabase = closest(target, '[data-nav-database]');
			if (navDatabase && !closest(target, '.btn-icon')) {
				var db = navDatabase.getAttribute('data-nav-database');
				var dbKey = selectedConnectionId + '|' + db;
				explorerPath = { connectionId: selectedConnectionId, database: db };
				// Load schema if not cached
				if (!databaseSchemas[dbKey]) {
					vscode.postMessage({ type: 'database.getSchema', connectionId: selectedConnectionId, database: db });
				}
				renderExplorer();
				return;
			}
			
			// Navigate to section (tables/functions)
			var navSection = closest(target, '[data-nav-section]');
			if (navSection) {
				var section = navSection.getAttribute('data-nav-section');
				explorerPath.section = section;
				explorerPath.folderPath = [];
				renderExplorer();
				return;
			}
			
			// Navigate into folder
			var navFolder = closest(target, '[data-nav-folder]');
			if (navFolder) {
				var folderName = navFolder.getAttribute('data-nav-folder');
				explorerPath.folderPath = explorerPath.folderPath || [];
				explorerPath.folderPath.push(folderName);
				renderExplorer();
				return;
			}
			
			// Toggle table expand/collapse (show details inline)
			var toggleTable = closest(target, '[data-toggle-table]');
			if (toggleTable) {
				var tableKey = toggleTable.getAttribute('data-toggle-table');
				if (expandedTables.has(tableKey)) {
					expandedTables.delete(tableKey);
				} else {
					expandedTables.add(tableKey);
				}
				renderExplorer();
				return;
			}

			// Toggle function expand/collapse (show details inline)
			var toggleFunction = closest(target, '[data-toggle-function]');
			if (toggleFunction) {
				var fnKey = toggleFunction.getAttribute('data-toggle-function');
				if (expandedFunctions.has(fnKey)) {
					expandedFunctions.delete(fnKey);
				} else {
					expandedFunctions.add(fnKey);
				}
				renderExplorer();
				return;
			}

			// Navigate to table columns (legacy - now replaced by inline expansion)
			var navTable = closest(target, '[data-nav-table]');
			if (navTable) {
				var tableName = navTable.getAttribute('data-nav-table');
				// Store current folder path so we can add table-columns view
				var currentFolderPath = explorerPath.folderPath ? explorerPath.folderPath.slice() : [];
				explorerPath = {
					connectionId: selectedConnectionId,
					database: explorerPath.database,
					section: 'table-columns',
					tableName: tableName,
					folderPath: currentFolderPath
				};
				renderExplorer();
				return;
			}

			// Drill into database (legacy - remove this handler)
			var drillDb = closest(target, '[data-drill-db]');
			if (drillDb && !closest(target, '[data-toggle-db-fav]')) {
				// This is now handled by data-nav-database
				return;
			}

			// Favorite item click
			var favItem = closest(target, '.favorite-item');
			if (favItem && !closest(target, '.btn-icon')) {
				var connId = favItem.getAttribute('data-fav-conn');
				var favDb = favItem.getAttribute('data-fav-db');
				
				// Helper function to navigate to the favorite database
				function navigateToFavoriteDatabase(connectionId, database) {
					if (connectionId && database) {
						var dbKey = connectionId + '|' + database;
						explorerPath = { connectionId: connectionId, database: database };
						// Load schema if not cached
						if (!databaseSchemas[dbKey]) {
							vscode.postMessage({ type: 'database.getSchema', connectionId: connectionId, database: database });
						}
					}
				}
				
				if (connId) {
					selectedConnectionId = connId;
					vscode.postMessage({ type: 'cluster.expand', connectionId: connId });
					navigateToFavoriteDatabase(connId, favDb);
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
								navigateToFavoriteDatabase(c.id, favDb);
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

	private getColumnIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M5 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H5zm0 1h6v12H5V2z"/>
			<path d="M7 4h2v1H7V4zm0 2h2v1H7V6zm0 2h2v1H7V8zm0 2h2v1H7v-1z"/>
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

	private getChevronRightIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M6 4l4 4-4 4V4z"/>
		</svg>`;
	}

	private getInfoIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12z"/>
			<path d="M8 4.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM7 8h2v4H7V8z"/>
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

	private getBackIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path fill-rule="evenodd" clip-rule="evenodd" d="M5.854 3.646a.5.5 0 0 1 0 .708L2.707 7.5H14a.5.5 0 0 1 0 1H2.707l3.147 3.146a.5.5 0 0 1-.708.708l-4-4a.5.5 0 0 1 0-.708l4-4a.5.5 0 0 1 .708 0z"/>
		</svg>`;
	}

	private getSidebarIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M0 2.5A1.5 1.5 0 0 1 1.5 1h13A1.5 1.5 0 0 1 16 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-11zM1.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5H5V2H1.5zM6 2v12h8.5a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5H6z"/>
		</svg>`;
	}

	private getShieldIcon(): string {
		return `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M8 0.5l-6 2v4c0 3.5 2.5 6.5 6 8 3.5-1.5 6-4.5 6-8v-4l-6-2zm4.5 5.5c0 2.8-1.9 5.2-4.5 6.5-2.6-1.3-4.5-3.7-4.5-6.5v-3l4.5-1.5 4.5 1.5v3z"/>
		</svg>`;
	}
}
