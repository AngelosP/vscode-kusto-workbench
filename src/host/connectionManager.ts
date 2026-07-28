import * as vscode from 'vscode';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { KustoLeaveNoTracePolicyStore, type KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore.js';
import { getWorkbenchLogger } from './workbenchLogger.js';

export interface KustoConnection {
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
	authorityId?: string;
}

/**
 * Manages Kusto cluster connections
 */
export interface FileConnectionEntry {
	clusterUrl: string;
	database: string;
	authorityId?: string;
	connectionIdHint?: string;
}

export type KustoConnectionChange =
	| { type: 'added'; connection: KustoConnection }
	| { type: 'updated'; connection: KustoConnection; previous: KustoConnection }
	| { type: 'removed'; connection: KustoConnection }
	| { type: 'cleared'; connections: KustoConnection[] };

export type KustoLeaveNoTraceChange = Readonly<{
	clusterUrl: string;
	enabled: boolean;
	revision: number;
	connectionIds: readonly string[];
}>;

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

export class ConnectionManager implements vscode.Disposable {
	private connections: KustoConnection[] = [];
	private readonly connectionIncarnations = new Map<string, number>();
	private readonly storageKey = 'kusto.connections';
	private readonly fileConnectionCacheKey = 'kusto.fileConnectionCache';
	private readonly changeEmitter = new vscode.EventEmitter<KustoConnectionChange>();
	readonly onDidChangeConnections = this.changeEmitter.event;
	private readonly leaveNoTraceChangeEmitter = new vscode.EventEmitter<KustoLeaveNoTraceChange>();
	readonly onDidChangeLeaveNoTrace = this.leaveNoTraceChangeEmitter.event;
	private readonly leaveNoTracePolicy: KustoLeaveNoTracePolicyStore;
	private readonly leaveNoTraceSubscription: vscode.Disposable;
	private disposed = false;

	constructor(private context: vscode.ExtensionContext) {
		this.loadConnections();
		this.leaveNoTracePolicy = new KustoLeaveNoTracePolicyStore(context, getWorkbenchLogger());
		this.leaveNoTraceSubscription = this.leaveNoTracePolicy.onDidChange(change => {
			const invalidated = change.globallyBlocked
				? [...new Set(this.connections.map(connection => this.normalizeClusterUrl(connection.clusterUrl)).filter(Boolean))]
				: [...change.invalidatedClusterKeys];
			for (const clusterUrl of invalidated) {
				const connectionIds = this.connections
					.filter(connection => this.normalizeClusterUrl(connection.clusterUrl) === clusterUrl)
					.map(connection => connection.id);
				this.leaveNoTraceChangeEmitter.fire(Object.freeze({
					clusterUrl,
					enabled: change.globallyBlocked || change.clusterKeys.includes(clusterUrl),
					revision: this.leaveNoTracePolicy.getRevocationGeneration(clusterUrl),
					connectionIds,
				}));
			}
		});
		if (Array.isArray(context.subscriptions)) context.subscriptions.push(this);
	}

	private loadConnections() {
		const stored = this.context.globalState.get<KustoConnection[]>(this.storageKey);
		if (stored) {
			this.connections = stored.flatMap(connection => {
				if (!connection || typeof connection !== 'object') return [];
				const id = String(connection.id || '').trim();
				const name = String(connection.name || '').trim();
				const clusterUrl = String(connection.clusterUrl || '').trim();
				if (!id || !name || !clusterUrl) return [];
				const authorityIdRaw = String(connection.authorityId || '').trim();
				let authorityId: string | undefined;
				try { authorityId = normalizeKustoAuthorityId(authorityIdRaw); } catch { authorityId = authorityIdRaw || undefined; }
				return [{ id, name, clusterUrl, database: String(connection.database || '').trim() || undefined, ...(authorityId ? { authorityId } : {}) }];
			});
		}
		for (const connection of this.connections) this.connectionIncarnations.set(connection.id, 1);
		void vscode.commands.executeCommand('setContext', 'kusto.hasConnections', this.connections.length > 0);
	}

	private bumpConnectionIncarnation(connectionId: string): number {
		const id = String(connectionId || '').trim();
		if (!id) return 0;
		const next = (this.connectionIncarnations.get(id) ?? 0) + 1;
		this.connectionIncarnations.set(id, next);
		return next;
	}

	getConnectionIncarnation(connectionId: string): number {
		return this.connectionIncarnations.get(String(connectionId || '').trim()) ?? 0;
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
		return this.leaveNoTracePolicy.isGloballyBlocked()
			? [...new Set(this.connections.map(connection => this.normalizeClusterUrl(connection.clusterUrl)).filter(Boolean))]
			: this.leaveNoTracePolicy.getClusterKeys();
	}

	isLeaveNoTraceRecoveryBlocked(): boolean {
		return this.leaveNoTracePolicy.isGloballyBlocked();
	}

	getLeaveNoTraceRevision(clusterUrl: string): number {
		return this.leaveNoTracePolicy.getRevocationGeneration(clusterUrl);
	}

	/**
	 * Check if a cluster URL is marked as "Leave no trace".
	 */
	isLeaveNoTrace(clusterUrl: string): boolean {
		return this.leaveNoTracePolicy.isProtected(clusterUrl);
	}

	/**
	 * Mark a cluster as "Leave no trace".
	 */
	async addLeaveNoTrace(clusterUrl: string): Promise<void> {
		await this.leaveNoTracePolicy.setCluster(clusterUrl, true);
	}

	/**
	 * Remove a cluster from "Leave no trace".
	 */
	async removeLeaveNoTrace(clusterUrl: string): Promise<void> {
		await this.leaveNoTracePolicy.setCluster(clusterUrl, false);
	}

	prepareLeaveNoTraceDispatch<T>(clusterUrl: string, start: (revocationGeneration: number) => T): Promise<{ value: T; revocationGeneration: number }> {
		return this.leaveNoTracePolicy.prepareDispatch(clusterUrl, start);
	}

	admitLeaveNoTraceRevision<T>(clusterUrl: string, expectedGeneration: number, admit: () => T | PromiseLike<T>): Promise<{ admitted: boolean; value?: Awaited<T> }> {
		return this.leaveNoTracePolicy.admitRevision(clusterUrl, expectedGeneration, admit);
	}

	runWithLeaveNoTraceSnapshotLock<T>(run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>): Promise<T> {
		return this.leaveNoTracePolicy.runWithSnapshotLock(run);
	}

	async refreshLeaveNoTracePolicy(): Promise<void> {
		await this.leaveNoTracePolicy.refresh();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.leaveNoTraceSubscription.dispose();
		this.leaveNoTracePolicy.dispose();
		this.leaveNoTraceChangeEmitter.dispose();
		this.changeEmitter.dispose();
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

		return {
			clusterUrl: entry.clusterUrl,
			database: entry.database,
			...(String(entry.authorityId || '').trim() ? { authorityId: String(entry.authorityId).trim() } : {}),
			...(String(entry.connectionIdHint || '').trim() ? { connectionIdHint: String(entry.connectionIdHint).trim() } : {}),
		};
	}

	/**
	 * Cache the connection (cluster + database) for a file path.
	 * Used to remember the last connection used for .kql/.csl files without sidecars.
	 * Sets the expiry timer to 30 days from now.
	 */
	async setFileConnection(
		filePath: string,
		clusterUrl: string,
		database: string,
		options?: { authorityId?: string; connectionIdHint?: string },
	): Promise<void> {
		const key = this.normalizeFilePath(filePath);
		if (!key) return;
		const trimmedCluster = String(clusterUrl || '').trim();
		const trimmedDb = String(database || '').trim();
		if (!trimmedCluster) return;
		const cache = this.context.globalState.get<Record<string, FileConnectionCacheEntry>>(this.fileConnectionCacheKey) || {};
		const now = Date.now();
		const authorityId = normalizeKustoAuthorityId(options?.authorityId);
		const connectionIdHint = String(options?.connectionIdHint || '').trim() || undefined;
		cache[key] = {
			clusterUrl: trimmedCluster,
			database: trimmedDb,
			lastAccessedAt: now,
			...(authorityId ? { authorityId } : {}),
			...(connectionIdHint ? { connectionIdHint } : {}),
		};
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
		const authorityId = normalizeKustoAuthorityId(connection.authorityId);
		const newConnection: KustoConnection = {
			...connection,
			...(authorityId ? { authorityId } : { authorityId: undefined }),
			id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
		};
		this.bumpConnectionIncarnation(newConnection.id);
		this.connections.push(newConnection);
		await this.saveConnections();
		this.changeEmitter.fire({ type: 'added', connection: { ...newConnection } });
		return newConnection;
	}

	async removeConnection(id: string): Promise<void> {
		const removed = this.connections.find(c => c.id === id);
		if (removed) this.bumpConnectionIncarnation(id);
		this.connections = this.connections.filter(c => c.id !== id);
		await this.saveConnections();
		if (removed) this.changeEmitter.fire({ type: 'removed', connection: { ...removed } });
	}

	async clearConnections(): Promise<number> {
		const previous = this.connections.map(connection => ({ ...connection }));
		const removed = previous.length;
		for (const connection of previous) this.bumpConnectionIncarnation(connection.id);
		this.connections = [];
		await this.saveConnections();
		if (previous.length) this.changeEmitter.fire({ type: 'cleared', connections: previous });
		return removed;
	}

	async updateConnection(id: string, updates: Partial<KustoConnection>): Promise<void> {
		const index = this.connections.findIndex(c => c.id === id);
		if (index !== -1) {
			const previous = { ...this.connections[index] };
			const authorityId = Object.prototype.hasOwnProperty.call(updates, 'authorityId')
				? normalizeKustoAuthorityId(updates.authorityId)
				: previous.authorityId;
			this.connections[index] = { ...previous, ...updates, ...(authorityId ? { authorityId } : { authorityId: undefined }) };
			if (getKustoConnectionIdentityKey(previous.clusterUrl, previous.authorityId)
				!== getKustoConnectionIdentityKey(this.connections[index].clusterUrl, this.connections[index].authorityId)) {
				this.bumpConnectionIncarnation(id);
			}
			await this.saveConnections();
			this.changeEmitter.fire({ type: 'updated', connection: { ...this.connections[index] }, previous });
		}
	}

}

// ── Standalone pure function export ──────────────────────────────────────────

/**
 * Normalize a cluster URL for consistent comparison.
 * Ensures `https://` prefix and lowercases the result. Strips trailing slashes.
 */
export function normalizeClusterUrl(clusterUrl: string): string {
	return kustoClusterKey(clusterUrl);
}
