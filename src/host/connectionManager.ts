import * as vscode from 'vscode';

export interface KustoConnection {
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
}

/**
 * Manages Kusto cluster connections
 */
export interface FileConnectionEntry {
	clusterUrl: string;
	database: string;
}

/**
 * Internal storage format for file connection cache entries.
 * Includes a timestamp so entries can expire after a period of inactivity.
 */
export interface FileConnectionCacheEntry extends FileConnectionEntry {
	/** Epoch ms of the last read or write. Entries older than MAX_AGE are pruned. */
	lastAccessedAt: number;
}

/** File connection cache entries expire after 30 days of inactivity. */
export const FILE_CONNECTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove expired entries from a file connection cache object in-place.
 * Pure function (mutates cache).
 */
export function pruneExpiredFileConnectionsSync(cache: Record<string, FileConnectionCacheEntry>, now: number, maxAgeMs: number = FILE_CONNECTION_MAX_AGE_MS): void {
	for (const k of Object.keys(cache)) {
		const e = cache[k];
		if (!e || typeof e.lastAccessedAt !== 'number' || (now - e.lastAccessedAt) > maxAgeMs) {
			delete cache[k];
		}
	}
}

/**
 * Normalize a file path for cache key usage.
 * Lowercases on Windows for case-insensitive matching.
 */
export function normalizeFilePath(filePath: string, isWindows: boolean = process.platform === 'win32'): string {
	const p = String(filePath || '').trim();
	if (!p) return '';
	if (isWindows) return p.toLowerCase();
	return p;
}

export class ConnectionManager {
	private connections: KustoConnection[] = [];
	private readonly storageKey = 'kusto.connections';
	private readonly leaveNoTraceKey = 'kusto.leaveNoTraceClusters';
	private readonly fileConnectionCacheKey = 'kusto.fileConnectionCache';

	constructor(private context: vscode.ExtensionContext) {
		this.loadConnections();
	}

	private loadConnections() {
		const stored = this.context.globalState.get<KustoConnection[]>(this.storageKey);
		if (stored) {
			this.connections = stored;
		}
		void vscode.commands.executeCommand('setContext', 'kusto.hasConnections', this.connections.length > 0);
	}

	private async saveConnections() {
		await this.context.globalState.update(this.storageKey, this.connections);
		void vscode.commands.executeCommand('setContext', 'kusto.hasConnections', this.connections.length > 0);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Leave No Trace API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get the list of cluster URLs marked as "Leave no trace".
	 * URLs are normalized (lowercase, no trailing slashes).
	 */
	getLeaveNoTraceClusters(): string[] {
		const stored = this.context.globalState.get<string[]>(this.leaveNoTraceKey);
		return Array.isArray(stored) ? stored : [];
	}

	/**
	 * Check if a cluster URL is marked as "Leave no trace".
	 */
	isLeaveNoTrace(clusterUrl: string): boolean {
		const normalized = this.normalizeClusterUrl(clusterUrl);
		if (!normalized) return false;
		return this.getLeaveNoTraceClusters().includes(normalized);
	}

	/**
	 * Mark a cluster as "Leave no trace".
	 */
	async addLeaveNoTrace(clusterUrl: string): Promise<void> {
		const normalized = this.normalizeClusterUrl(clusterUrl);
		if (!normalized) return;
		const current = this.getLeaveNoTraceClusters();
		if (!current.includes(normalized)) {
			current.push(normalized);
			await this.context.globalState.update(this.leaveNoTraceKey, current);
		}
	}

	/**
	 * Remove a cluster from "Leave no trace".
	 */
	async removeLeaveNoTrace(clusterUrl: string): Promise<void> {
		const normalized = this.normalizeClusterUrl(clusterUrl);
		if (!normalized) return;
		const current = this.getLeaveNoTraceClusters();
		const filtered = current.filter(u => u !== normalized);
		await this.context.globalState.update(this.leaveNoTraceKey, filtered);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// File Connection Cache API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get the cached connection (cluster + database) for a file path.
	 * Used to remember the last connection used for .kql/.csl files without sidecars.
	 * Returns undefined if no entry exists or the entry has expired (30 days of inactivity).
	 * Accessing an entry refreshes its expiry timer.
	 */
	getFileConnection(filePath: string): FileConnectionEntry | undefined {
		const key = this.normalizeFilePath(filePath);
		if (!key) return undefined;
		const cache = this.context.globalState.get<Record<string, FileConnectionCacheEntry>>(this.fileConnectionCacheKey);
		if (!cache || typeof cache !== 'object') return undefined;
		const entry = cache[key];
		if (!entry || typeof entry.clusterUrl !== 'string' || typeof entry.database !== 'string') return undefined;
		if (!entry.clusterUrl.trim()) return undefined;

		// Check expiry.
		const now = Date.now();
		if (typeof entry.lastAccessedAt === 'number' && (now - entry.lastAccessedAt) > FILE_CONNECTION_MAX_AGE_MS) {
			// Entry expired — remove it (and prune any other stale entries).
			void this.pruneExpiredFileConnections(cache, now);
			return undefined;
		}

		// NOTE: We intentionally do NOT touch lastAccessedAt on read.
		// setFileConnection() already refreshes the timestamp on write,
		// and fire-and-forget writes from getFileConnection() can race with
		// awaited writes from setFileConnection(), causing data loss.
		// The 30-day expiry window is long enough that write-only touch is sufficient.

		return { clusterUrl: entry.clusterUrl, database: entry.database };
	}

	/**
	 * Cache the connection (cluster + database) for a file path.
	 * Used to remember the last connection used for .kql/.csl files without sidecars.
	 * Sets the expiry timer to 30 days from now.
	 */
	async setFileConnection(filePath: string, clusterUrl: string, database: string): Promise<void> {
		const key = this.normalizeFilePath(filePath);
		if (!key) return;
		const trimmedCluster = String(clusterUrl || '').trim();
		const trimmedDb = String(database || '').trim();
		if (!trimmedCluster) return;
		const cache = this.context.globalState.get<Record<string, FileConnectionCacheEntry>>(this.fileConnectionCacheKey) || {};
		const now = Date.now();
		cache[key] = { clusterUrl: trimmedCluster, database: trimmedDb, lastAccessedAt: now };
		// Opportunistically prune expired entries on write.
		this.pruneExpiredFileConnectionsSync(cache, now);
		await this.context.globalState.update(this.fileConnectionCacheKey, cache);
	}

	/**
	 * Remove expired entries from the file connection cache (async, fire-and-forget).
	 */
	private async pruneExpiredFileConnections(cache: Record<string, FileConnectionCacheEntry>, now: number): Promise<void> {
		this.pruneExpiredFileConnectionsSync(cache, now);
		await this.context.globalState.update(this.fileConnectionCacheKey, cache);
	}

	/**
	 * Remove expired entries from the cache object in-place.
	 */
	private pruneExpiredFileConnectionsSync(cache: Record<string, FileConnectionCacheEntry>, now: number): void {
		pruneExpiredFileConnectionsSync(cache, now);
	}

	/**
	 * Normalize a file path for use as a cache key.
	 * Uses lowercase on Windows for case-insensitive matching.
	 */
	private normalizeFilePath(filePath: string): string {
		return normalizeFilePath(filePath);
	}

	/**
	 * Normalize a cluster URL for consistent comparison.
	 */
	normalizeClusterUrl(clusterUrl: string): string {
		return normalizeClusterUrl(clusterUrl);
	}

	getConnections(): KustoConnection[] {
		return [...this.connections];
	}

	async addConnection(connection: Omit<KustoConnection, 'id'>): Promise<KustoConnection> {
		const newConnection: KustoConnection = {
			...connection,
			id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
		};
		this.connections.push(newConnection);
		await this.saveConnections();
		return newConnection;
	}

	async removeConnection(id: string): Promise<void> {
		this.connections = this.connections.filter(c => c.id !== id);
		await this.saveConnections();
	}

	async clearConnections(): Promise<number> {
		const removed = this.connections.length;
		this.connections = [];
		await this.saveConnections();
		return removed;
	}

	async updateConnection(id: string, updates: Partial<KustoConnection>): Promise<void> {
		const index = this.connections.findIndex(c => c.id === id);
		if (index !== -1) {
			this.connections[index] = { ...this.connections[index], ...updates };
			await this.saveConnections();
		}
	}

	async showConnectionManager() {
		const actions = [
			{ label: '$(add) Add New Connection', action: 'add' },
			{ label: '$(list-unordered) View Connections', action: 'list' }
		];

		const selection = await vscode.window.showQuickPick(actions, {
			placeHolder: 'Manage Kusto Connections'
		});

		if (selection?.action === 'add') {
			await this.addConnectionDialog();
		} else if (selection?.action === 'list') {
			await this.listConnections();
		}
	}

	private async addConnectionDialog() {
		const name = await vscode.window.showInputBox({
			prompt: 'Connection Name',
			placeHolder: 'My Kusto Cluster'
		});

		if (!name) {return;}

		const clusterUrl = await vscode.window.showInputBox({
			prompt: 'Cluster URL',
			placeHolder: 'https://mycluster.region.kusto.windows.net'
		});

		if (!clusterUrl) {return;}

		const database = await vscode.window.showInputBox({
			prompt: 'Default Database (optional)',
			placeHolder: 'MyDatabase'
		});

		await this.addConnection({ name, clusterUrl, database });
		vscode.window.showInformationMessage(`Connection "${name}" added successfully!`);
	}

	private async listConnections() {
		if (this.connections.length === 0) {
			vscode.window.showInformationMessage('No connections configured. Add one first!');
			return;
		}

		const items = this.connections.map(conn => ({
			label: conn.name,
			description: conn.clusterUrl,
			detail: conn.database ? `Default DB: ${conn.database}` : 'No default database',
			connection: conn
		}));

		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a connection to manage'
		});

		if (selection) {
			const action = await vscode.window.showQuickPick([
				{ label: '$(trash) Delete', action: 'delete' },
				{ label: '$(edit) Edit', action: 'edit' }
			]);

			if (action?.action === 'delete') {
				await this.removeConnection(selection.connection.id);
				vscode.window.showInformationMessage(`Connection "${selection.connection.name}" deleted.`);
			}
		}
	}
}

// ── Standalone pure function export ──────────────────────────────────────────

/**
 * Normalize a cluster URL for consistent comparison.
 * Ensures `https://` prefix and lowercases the result. Strips trailing slashes.
 */
export function normalizeClusterUrl(clusterUrl: string): string {
	let u = String(clusterUrl || '').trim();
	if (!u) return '';
	if (!/^https?:\/\//i.test(u)) {
		u = 'https://' + u;
	}
	return u.replace(/\/+$/g, '').toLowerCase();
}
