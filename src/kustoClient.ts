import { KustoConnection } from './connectionManager';
import * as vscode from 'vscode';

export interface QueryResult {
	columns: string[];
	rows: any[][];
	metadata: {
		cluster: string;
		database: string;
		executionTime: string;
	};
}

export interface DatabaseSchemaIndex {
	tables: string[];
	columnsByTable: Record<string, string[]>;
	/**
	 * Optional column type information when available from schema queries.
	 * Keys and values are best-effort and depend on the server/driver schema shape.
	 */
	columnTypesByTable?: Record<string, Record<string, string>>;
}

export interface DatabaseSchemaResult {
	schema: DatabaseSchemaIndex;
	fromCache: boolean;
	cacheAgeMs?: number;
	debug?: {
		commandUsed?: string;
		primaryColumns?: string[];
		sampleRowType?: string;
		sampleRowKeys?: string[];
		sampleRowPreview?: string;
	};
}

export class QueryCancelledError extends Error {
	readonly isCancelled = true;
	constructor(message: string = 'Query cancelled') {
		super(message);
		this.name = 'QueryCancelledError';
	}
}

type StoredAuthAccount = {
	/** VS Code AuthenticationSession.account.id */
	id: string;
	/** VS Code AuthenticationSession.account.label */
	label: string;
	/** Last time we successfully used this account for any cluster. */
	lastUsedAt: number;
};

type StoredClusterAccountMap = Record<string, string>; // clusterEndpoint -> accountId

type SessionPromptMode = 'default' | 'clearPreference' | 'forceNewSession';

type CachedClientEntry = {
	client: any;
	clusterEndpoint: string;
	accountId: string;
};

export class KustoQueryClient {
	private clients: Map<string, CachedClientEntry> = new Map();
	// Dedicated clients used for cancelable query execution. Keyed by box/run context to
	// (a) support cancellation without impacting other editors, and (b) improve server-side
	// query results cache hit rate by reusing the same underlying HTTP session.
	// IMPORTANT: The key must include connection identity (e.g. boxId + connection.id).
	// Otherwise switching clusters in the same box would reuse the previous cluster's client.
	private cancelableClientsByKey: Map<string, CachedClientEntry> = new Map();
	private databaseCache: Map<string, { databases: string[], timestamp: number }> = new Map();
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly SCHEMA_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

	private static readonly AUTH_PROVIDER_ID = 'microsoft';
	private static readonly AUTH_SCOPES = ['https://kusto.kusto.windows.net/.default'] as const;
	private static readonly STORAGE_KEYS = {
		knownAccounts: 'kusto.auth.knownAccounts',
		clusterAccountMap: 'kusto.auth.clusterAccountMap'
	} as const;

	private readonly context?: vscode.ExtensionContext;
	private readonly authLocksByCluster = new Map<string, Promise<void>>();

	constructor(context?: vscode.ExtensionContext) {
		this.context = context;
	}

	/**
	 * Forces an interactive auth prompt for the given connection and refreshes the cached client.
	 * Useful for explicit user actions like "Refresh databases" when the current account has no access.
	 */
	public async reauthenticate(connection: KustoConnection, promptMode: 'clearPreference' | 'forceNewSession' = 'clearPreference'): Promise<void> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}
		try {
			const existing = this.clients.get(connection.id);
			this.clients.delete(connection.id);
			existing?.client?.close?.();
		} catch {
			// ignore
		}
		// Explicit user action: skip silent selection so VS Code shows an account picker/sign-in.
		await this.createClientWithRetry(connection, { interactiveIfNeeded: true, promptMode, skipSilent: true });
	}

	public isAuthenticationError(error: unknown): boolean {
		return this.isAuthError(error);
	}

	private normalizeClusterEndpoint(clusterUrl: string): string {
		const raw = String(clusterUrl || '').trim();
		if (!raw) {
			return '';
		}
		try {
			const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
			const u = new URL(withScheme);
			let host = String(u.hostname || '').trim();
			// If we got a short name like "help" or "mycluster.westus", expand it.
			// This intentionally targets the common public ADX domain.
			if (host && !/\.kusto\./i.test(host)) {
				host = `${host}.kusto.windows.net`;
			}
			const protocol = u.protocol && /^https?:$/i.test(u.protocol) ? u.protocol : 'https:';
			return `${protocol}//${host}`;
		} catch {
			// Best-effort string fallback.
			let v = raw;
			if (!/^https?:\/\//i.test(v)) {
				v = `https://${v.replace(/^\/+/, '')}`;
			}
			try {
				const u2 = new URL(v);
				let host = String(u2.hostname || '').trim();
				if (host && !/\.kusto\./i.test(host)) {
					host = `${host}.kusto.windows.net`;
				}
				return `${u2.protocol}//${host}`;
			} catch {
				return v;
			}
		}
	}

	private async getOrCreateClient(connection: KustoConnection): Promise<any> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}

		const mappedAccountId = this.getClusterAccountId(clusterEndpoint);
		if (mappedAccountId) {
			const existing = this.clients.get(connection.id);
			if (existing && existing.clusterEndpoint === clusterEndpoint && existing.accountId === mappedAccountId) {
				return existing.client;
			}
		}

		// Create/refresh client via auth flow (may use silent retries and only prompt if needed).
		const { client } = await this.createClientWithRetry(connection, { interactiveIfNeeded: true });
		return client;
	}

	private async createDedicatedClient(connection: KustoConnection, opts?: { interactiveIfNeeded?: boolean }): Promise<CachedClientEntry> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}
		const { session, accountId } = await this.getSessionForCluster(clusterEndpoint, {
			interactiveIfNeeded: !!opts?.interactiveIfNeeded,
			promptMode: 'default'
		});
		if (!session || !accountId) {
			throw new Error('Failed to authenticate with Microsoft');
		}
		// Persist successful auth selection for this cluster.
		try {
			await this.upsertKnownAccount(session.account);
			await this.setClusterAccountId(clusterEndpoint, session.account.id);
		} catch {
			// Non-fatal: auth still works even if persistence fails.
		}
		const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
		const kcsb = KustoConnectionStringBuilder.withAccessToken(clusterEndpoint, session.accessToken);
		return { client: new Client(kcsb), clusterEndpoint, accountId };
	}

	private async getOrCreateCancelableClient(connection: KustoConnection, key: string): Promise<any> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const mappedAccountId = this.getClusterAccountId(clusterEndpoint);
		const existing = this.cancelableClientsByKey.get(key);
		if (existing && mappedAccountId && existing.clusterEndpoint === clusterEndpoint && existing.accountId === mappedAccountId) {
			return existing.client;
		}
		if (existing) {
			try { existing.client?.close?.(); } catch { /* ignore */ }
			this.cancelableClientsByKey.delete(key);
		}
		const created = await this.createClientWithRetry(connection, { interactiveIfNeeded: true, storeInMainClientCache: false });
		this.cancelableClientsByKey.set(key, created);
		return created.client;
	}

	private getKnownAccounts(): StoredAuthAccount[] {
		if (!this.context) {
			return [];
		}
		const raw = this.context.globalState.get<StoredAuthAccount[] | undefined>(KustoQueryClient.STORAGE_KEYS.knownAccounts);
		return Array.isArray(raw) ? raw.filter(a => a && typeof a.id === 'string' && typeof a.label === 'string') : [];
	}

	private async upsertKnownAccount(account: vscode.AuthenticationSessionAccountInformation): Promise<void> {
		if (!this.context) {
			return;
		}
		const now = Date.now();
		const existing = this.getKnownAccounts();
		const filtered = existing.filter(a => a.id !== account.id);
		filtered.unshift({ id: account.id, label: account.label, lastUsedAt: now });
		// Keep list bounded.
		await this.context.globalState.update(KustoQueryClient.STORAGE_KEYS.knownAccounts, filtered.slice(0, 10));
	}

	private getClusterAccountId(clusterEndpoint: string): string | undefined {
		if (!this.context) {
			return undefined;
		}
		const map = this.context.globalState.get<StoredClusterAccountMap | undefined>(KustoQueryClient.STORAGE_KEYS.clusterAccountMap);
		if (!map || typeof map !== 'object') {
			return undefined;
		}
		const v = (map as any)[clusterEndpoint];
		return typeof v === 'string' && v ? v : undefined;
	}

	private async setClusterAccountId(clusterEndpoint: string, accountId: string): Promise<void> {
		if (!this.context) {
			return;
		}
		const prev = this.context.globalState.get<StoredClusterAccountMap | undefined>(KustoQueryClient.STORAGE_KEYS.clusterAccountMap);
		const next: StoredClusterAccountMap = { ...(prev && typeof prev === 'object' ? prev : {}) };
		next[clusterEndpoint] = accountId;
		await this.context.globalState.update(KustoQueryClient.STORAGE_KEYS.clusterAccountMap, next);
	}

	private isAuthError(error: unknown): boolean {
		const anyErr = error as any;
		const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(error || '');
		const lower = msg.toLowerCase();
		if (lower.includes('aadsts') || lower.includes('aads')) {
			return true;
		}
		if (lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('authorization')) {
			return true;
		}
		// azure-kusto-data often wraps HTTP errors; check status codes when present.
		const status = anyErr?.statusCode ?? anyErr?.response?.status ?? anyErr?.response?.statusCode;
		return status === 401 || status === 403;
	}

	private async getSessionForCluster(
		clusterEndpoint: string,
		opts: { interactiveIfNeeded: boolean; promptMode?: SessionPromptMode; skipSilent?: boolean }
	): Promise<{ session: vscode.AuthenticationSession | undefined; accountId: string | undefined }>
	{
		// If we have no storage (e.g. unit tests), just fall back to interactive.
		if (!this.context) {
			const session = await vscode.authentication.getSession(
				KustoQueryClient.AUTH_PROVIDER_ID,
				[...KustoQueryClient.AUTH_SCOPES],
				{ createIfNone: true }
			);
			return { session, accountId: session?.account?.id };
		}

		const mapped = this.getClusterAccountId(clusterEndpoint);
		const known = this.getKnownAccounts().sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
		const candidates: StoredAuthAccount[] = [];
		if (mapped) {
			const inKnown = known.find(a => a.id === mapped);
			if (inKnown) {
				candidates.push(inKnown);
			} else {
				// Keep label best-effort; VS Code uses id to match.
				candidates.push({ id: mapped, label: mapped, lastUsedAt: 0 });
			}
		}
		for (const a of known) {
			if (!candidates.some(c => c.id === a.id)) {
				candidates.push(a);
			}
		}

		// Silent attempts first (unless explicitly skipped).
		if (!opts.skipSilent) {
			for (const account of candidates) {
				try {
					const session = await vscode.authentication.getSession(
						KustoQueryClient.AUTH_PROVIDER_ID,
						[...KustoQueryClient.AUTH_SCOPES],
						{ silent: true, account: { id: account.id, label: account.label } }
					);
					if (session) {
						return { session, accountId: session.account.id };
					}
				} catch {
					// Silent path shouldn't throw, but be defensive.
				}
			}
		}

		if (!opts.interactiveIfNeeded) {
			return { session: undefined, accountId: undefined };
		}

		// Finally: interactive prompt.
		// IMPORTANT: In multi-account scenarios, VS Code may return an existing session without
		// prompting unless we clear preference / force a new session.
		const promptMode: SessionPromptMode = opts.promptMode ?? 'default';
		const interactiveOptions: vscode.AuthenticationGetSessionOptions =
			promptMode === 'forceNewSession'
				? { forceNewSession: true }
				: promptMode === 'clearPreference'
					? { createIfNone: true, clearSessionPreference: true }
					: { createIfNone: true };

		const session = await vscode.authentication.getSession(
			KustoQueryClient.AUTH_PROVIDER_ID,
			[...KustoQueryClient.AUTH_SCOPES],
			interactiveOptions
		);
		if (session?.account) {
			await this.upsertKnownAccount(session.account);
			await this.setClusterAccountId(clusterEndpoint, session.account.id);
		}
		return { session, accountId: session?.account?.id };
	}

	private async withClusterAuthLock(clusterEndpoint: string, fn: () => Promise<void>): Promise<void> {
		const existing = this.authLocksByCluster.get(clusterEndpoint);
		if (existing) {
			await existing;
		}
		let resolveFn: (() => void) | undefined;
		const p = new Promise<void>((resolve) => { resolveFn = resolve; });
		this.authLocksByCluster.set(clusterEndpoint, p);
		try {
			await fn();
		} finally {
			try { resolveFn?.(); } catch { /* ignore */ }
			this.authLocksByCluster.delete(clusterEndpoint);
		}
	}

	private async createClientWithRetry(
		connection: KustoConnection,
		opts: { interactiveIfNeeded: boolean; storeInMainClientCache?: boolean; promptMode?: SessionPromptMode; skipSilent?: boolean }
	): Promise<CachedClientEntry>
	{
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const storeInMain = opts.storeInMainClientCache !== false;

		// Ensure we don't race multiple auth prompts for the same cluster.
		let created: CachedClientEntry | undefined;
		await this.withClusterAuthLock(clusterEndpoint, async () => {
			// Re-check cache after waiting.
			const mappedAccountId = this.getClusterAccountId(clusterEndpoint);
			if (storeInMain && mappedAccountId) {
				const existing = this.clients.get(connection.id);
				if (existing && existing.clusterEndpoint === clusterEndpoint && existing.accountId === mappedAccountId) {
					created = existing;
					return;
				}
			}

			// Create client with the best session we can get (silent first, then optional interactive).
			// promptMode is only used for the final interactive step.
			const clusterEndpoint2 = this.normalizeClusterEndpoint(connection.clusterUrl);
			const { session, accountId } = await this.getSessionForCluster(clusterEndpoint2, {
				interactiveIfNeeded: opts.interactiveIfNeeded,
				promptMode: opts.promptMode ?? 'default',
				skipSilent: !!opts.skipSilent
			});
			if (!session || !accountId) {
				throw new Error('Failed to authenticate with Microsoft');
			}
			try {
				await this.upsertKnownAccount(session.account);
				await this.setClusterAccountId(clusterEndpoint2, session.account.id);
			} catch {
				// ignore
			}
			const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
			const kcsb = KustoConnectionStringBuilder.withAccessToken(clusterEndpoint2, session.accessToken);
			const entry: CachedClientEntry = { client: new Client(kcsb), clusterEndpoint: clusterEndpoint2, accountId };
			if (storeInMain) {
				this.clients.set(connection.id, entry);
			}
			created = entry;
		});
		if (!created) {
			throw new Error('Failed to authenticate with Microsoft');
		}
		return created;
	}

	private async executeWithAuthRetry<T>(
		connection: KustoConnection,
		operation: (client: any) => Promise<T>,
		opts?: { allowInteractive?: boolean; cancelableKey?: string; onClient?: (client: any) => void }
	): Promise<T> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const allowInteractive = opts?.allowInteractive !== false;

		// First attempt: use existing cached client (if any).
		try {
			const client = opts?.cancelableKey
				? await this.getOrCreateCancelableClient(connection, opts.cancelableKey)
				: await this.getOrCreateClient(connection);
			try { opts?.onClient?.(client); } catch { /* ignore */ }
			return await operation(client);
		} catch (error) {
			if (!this.isAuthError(error)) {
				throw error;
			}
			// Evict cached clients for this connection so we can retry with a different session/account.
			try {
				const existing = this.clients.get(connection.id);
				this.clients.delete(connection.id);
				existing?.client?.close?.();
			} catch {
				// ignore
			}
			if (opts?.cancelableKey) {
				try {
					const existing = this.cancelableClientsByKey.get(opts.cancelableKey);
					this.cancelableClientsByKey.delete(opts.cancelableKey);
					existing?.client?.close?.();
				} catch {
					// ignore
				}
			}
			// Retry path: try known accounts silently in order; if still failing and allowed, prompt.
			// We model this by attempting to (re)create a client and then re-run operation.
			const known = this.getKnownAccounts().sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
			for (const acct of known) {
				try {
					const session = await vscode.authentication.getSession(
						KustoQueryClient.AUTH_PROVIDER_ID,
						[...KustoQueryClient.AUTH_SCOPES],
						{ silent: true, account: { id: acct.id, label: acct.label } }
					);
					if (!session) {
						continue;
					}
					const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
					const kcsb = KustoConnectionStringBuilder.withAccessToken(clusterEndpoint, session.accessToken);
					const client = new Client(kcsb);
					await this.setClusterAccountId(clusterEndpoint, session.account.id);
					await this.upsertKnownAccount(session.account);
					if (opts?.cancelableKey) {
						this.cancelableClientsByKey.set(opts.cancelableKey, { client, clusterEndpoint, accountId: session.account.id });
					} else {
						this.clients.set(connection.id, { client, clusterEndpoint, accountId: session.account.id });
					}
					try { opts?.onClient?.(client); } catch { /* ignore */ }
					return await operation(client);
				} catch (err2) {
					if (this.isAuthError(err2)) {
						continue;
					}
					throw err2;
				}
			}

			if (!allowInteractive) {
				throw error;
			}

			// Interactive recovery:
			// 1) Clear session preference so the user can pick another existing account.
			// 2) If we still get an auth error, force a new session (sign in / add account).
			const tryInteractive = async (promptMode: SessionPromptMode) => {
				if (opts?.cancelableKey) {
					const created = await this.createClientWithRetry(connection, {
						interactiveIfNeeded: true,
						storeInMainClientCache: false,
						promptMode,
						skipSilent: true
					});
					this.cancelableClientsByKey.set(opts.cancelableKey, created);
					try { opts?.onClient?.(created.client); } catch { /* ignore */ }
					return await operation(created.client);
				}
				const created = await this.createClientWithRetry(connection, { interactiveIfNeeded: true, promptMode, skipSilent: true });
				try { opts?.onClient?.(created.client); } catch { /* ignore */ }
				return await operation(created.client);
			};

			try {
				return await tryInteractive('clearPreference');
			} catch (e2) {
				if (!this.isAuthError(e2)) {
					throw e2;
				}
				return await tryInteractive('forceNewSession');
			}
		}
	}

	private isLikelyCancellationError(error: unknown): boolean {
		const anyErr = error as any;
		if (anyErr?.isCancelled === true) {
			return true;
		}
		// Axios cancel token errors commonly set __CANCEL or use messages like "canceled".
		if (anyErr?.__CANCEL === true) {
			return true;
		}
		// Avoid treating generic network aborts/disconnects as user cancellations.
		// Only treat explicit cancellation signals as cancellations.
		if (typeof anyErr?.name === 'string' && anyErr.name === 'AbortError') {
			return true;
		}
		const msg = typeof anyErr?.message === 'string' ? anyErr.message : '';
		return /\bcancel(l)?ed\b|\bcanceled\b/i.test(msg);
	}

	async getDatabases(connection: KustoConnection, forceRefresh: boolean = false): Promise<string[]> {
		try {
			const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
			// Check cache first
			if (!forceRefresh) {
				const cached = this.databaseCache.get(clusterEndpoint);
				if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
					console.log('Returning cached databases for:', clusterEndpoint);
					return cached.databases;
				}
			}

			console.log('Fetching databases for cluster:', clusterEndpoint);
			console.log('Executing .show databases command');
			const result = await this.executeWithAuthRetry<any>(connection, (client) => client.execute('', '.show databases'));
			console.log('Query result received:', result);
			
			const databases: string[] = [];
			
			// Extract database names from the result
			const primaryResults = result.primaryResults[0];
			console.log('Primary results columns:', primaryResults.columns);
			
			for (const row of primaryResults.rows()) {
				// Database name is typically in the first column
				const dbName = row['DatabaseName'] || row[0];
				if (dbName) {
					databases.push(dbName.toString());
				}
			}
			
			console.log('Databases found:', databases);
			
			// Update cache
			this.databaseCache.set(clusterEndpoint, {
				databases,
				timestamp: Date.now()
			});
			
			return databases;
		} catch (error) {
			console.error('Error fetching databases:', error);
			throw new Error(`Failed to fetch databases: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async executeQuery(
		connection: KustoConnection,
		database: string,
		query: string
	): Promise<QueryResult> {
		const startTime = Date.now();
		
		try {
			const result = await this.executeWithAuthRetry<any>(connection, (client) => client.execute(database, query));
			const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';
			
			// Get the primary result
			const primaryResults = result.primaryResults[0];
			
			// Extract column names
			const columns = primaryResults.columns.map((col: any) => col.name || col.type || 'Unknown');
			
			// Helper function to format cell values
			const formatCellValue = (cell: any): { display: string; full: string; isObject?: boolean; rawObject?: any } => {
				if (cell === null || cell === undefined) {
					return { display: 'null', full: 'null' };
				}
				
				// Check if it's a Date object
				if (cell instanceof Date) {
					const full = cell.toString();
					// Format as YYYY-MM-DD HH:MM:SS
					const display = cell.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
					return { display, full };
				}
				
				// Check if it's an object or array (complex structure)
				if (typeof cell === 'object') {
					try {
						// Check if object/array is empty
						const isEmpty = Array.isArray(cell) 
							? cell.length === 0 
							: Object.keys(cell).length === 0;
						
						if (isEmpty) {
							const display = Array.isArray(cell) ? '[]' : '{}';
							return { display, full: display };
						}
						
						const jsonStr = JSON.stringify(cell, null, 2);
						return { 
							display: '[object]', 
							full: jsonStr,
							isObject: true,
							rawObject: cell
						};
					} catch (e) {
						// If JSON.stringify fails, fall back to string representation
						const str = String(cell);
						return { display: str, full: str };
					}
				}
				
				// Check if it's a string that looks like an ISO date
				const str = String(cell);
				const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
				if (isoDateRegex.test(str)) {
					try {
						const date = new Date(str);
						if (!isNaN(date.getTime())) {
							const full = date.toString();
							// Format as YYYY-MM-DD HH:MM:SS
							const display = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
							return { display, full };
						}
					} catch (e) {
						// Not a valid date, fall through
					}
				}
				
				return { display: str, full: str };
			};
			
			// Extract rows
			const rows: any[][] = [];
			for (const row of primaryResults.rows()) {
				// Row might be an object or array, convert to array
				const rowArray: any[] = [];
				if (Array.isArray(row)) {
					rowArray.push(...row);
				} else {
					// If it's an object, extract values based on column order
					for (const col of primaryResults.columns) {
						const value = (row as any)[col.name] ?? (row as any)[col.ordinal];
						rowArray.push(value);
					}
				}
				rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
			}
			
			return {
				columns,
				rows,
				metadata: {
					cluster: connection.clusterUrl,
					database: database,
					executionTime
				}
			};
		} catch (error) {
			console.error('Error executing query:', error);
			
			// Extract more detailed error information
			let errorMessage = 'Unknown error';
			if (error instanceof Error) {
				errorMessage = error.message;
				// Check if there's additional error info from Kusto
				if ((error as any).response?.data) {
					errorMessage = JSON.stringify((error as any).response.data);
				}
			} else {
				errorMessage = String(error);
			}
			
			throw new Error(errorMessage);
		}
	}

	executeQueryCancelable(
		connection: KustoConnection,
		database: string,
		query: string,
		clientKey?: string
	): { promise: Promise<QueryResult>; cancel: () => void } {
		const key = String(clientKey || connection.id || '').trim() || 'default';
		let client: any | undefined;
		let cancelled = false;
		const cancel = () => {
			cancelled = true;
			try {
				// Evict the client for this key so the next run starts clean.
				this.cancelableClientsByKey.delete(key);
				client?.close?.();
			} catch {
				// ignore
			}
		};

		const promise = (async () => {
			// If this run was cancelled before we even started, bail out early.
			if (cancelled) {
				throw new QueryCancelledError();
			}
			client = await this.getOrCreateCancelableClient(connection, key);
			// If we were cancelled while acquiring/creating the client, do not execute.
			if (cancelled) {
				throw new QueryCancelledError();
			}
			const startTime = Date.now();
			try {
				// Check again right before executing (cancellation can happen at any time).
				if (cancelled) {
					throw new QueryCancelledError();
				}
				const result = await this.executeWithAuthRetry<any>(
					connection,
					(c) => c.execute(database, query),
					{ allowInteractive: true, cancelableKey: key, onClient: (c2) => { client = c2; } }
				);
				const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';

				const primaryResults = result.primaryResults[0];
				const columns = primaryResults.columns.map((col: any) => col.name || col.type || 'Unknown');

				const formatCellValue = (cell: any): { display: string; full: string; isObject?: boolean; rawObject?: any } => {
					if (cell === null || cell === undefined) {
						return { display: 'null', full: 'null' };
					}
					if (cell instanceof Date) {
						const full = cell.toString();
						const display = cell.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
						return { display, full };
					}
					if (typeof cell === 'object') {
						try {
							const isEmpty = Array.isArray(cell) ? cell.length === 0 : Object.keys(cell).length === 0;
							if (isEmpty) {
								const display = Array.isArray(cell) ? '[]' : '{}';
								return { display, full: display };
							}
							const jsonStr = JSON.stringify(cell, null, 2);
							return { display: '[object]', full: jsonStr, isObject: true, rawObject: cell };
						} catch {
							const str = String(cell);
							return { display: str, full: str };
						}
					}

					const str = String(cell);
					const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
					if (isoDateRegex.test(str)) {
						try {
							const date = new Date(str);
							if (!isNaN(date.getTime())) {
								const full = date.toString();
								const display = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
								return { display, full };
							}
						} catch {
							// ignore
						}
					}
					return { display: str, full: str };
				};

				const rows: any[][] = [];
				for (const row of primaryResults.rows()) {
					const rowArray: any[] = [];
					if (Array.isArray(row)) {
						rowArray.push(...row);
					} else {
						for (const col of primaryResults.columns) {
							const value = (row as any)[col.name] ?? (row as any)[col.ordinal];
							rowArray.push(value);
						}
					}
					rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
				}

				return {
					columns,
					rows,
					metadata: {
						cluster: connection.clusterUrl,
						database: database,
						executionTime
					}
				};
			} catch (error) {
				if (cancelled || this.isLikelyCancellationError(error)) {
					throw new QueryCancelledError();
				}
				// If we hit a non-cancellation error, evict+close this client so a subsequent run
				// can recreate a fresh connection/session.
				try {
					this.cancelableClientsByKey.delete(key);
					client?.close?.();
				} catch {
					// ignore
				}
				console.error('Error executing query:', error);
				let errorMessage = 'Unknown error';
				if (error instanceof Error) {
					errorMessage = error.message;
					if ((error as any).response?.data) {
						errorMessage = JSON.stringify((error as any).response.data);
					}
				} else {
					errorMessage = String(error);
				}
				throw new Error(errorMessage);
			}
		})();

		return { promise, cancel };
	}

	async getDatabaseSchema(
		connection: KustoConnection,
		database: string,
		forceRefresh: boolean = false
	): Promise<DatabaseSchemaResult> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const cacheKey = `${clusterEndpoint}|${database}`;
		if (!forceRefresh) {
			const cached = this.schemaCache.get(cacheKey);
			if (cached && (Date.now() - cached.timestamp) < this.SCHEMA_CACHE_TTL) {
				return {
					schema: cached.schema,
					fromCache: true,
					cacheAgeMs: Date.now() - cached.timestamp
				};
			}
		}

		const tryCommands = [
			'.show database schema as json',
			'.show database schema'
		];

		let lastError: unknown = null;
		for (const command of tryCommands) {
			try {
				const result = await this.executeWithAuthRetry<any>(connection, (client) => client.execute(database, command));
				const debug = this.buildSchemaDebug(result, command);
				const schema = this.parseDatabaseSchemaResult(result);
				this.schemaCache.set(cacheKey, { schema, timestamp: Date.now() });
				return { schema, fromCache: false, debug };
			} catch (e) {
				lastError = e;
			}
		}

		throw new Error(
			`Failed to fetch database schema: ${lastError instanceof Error ? lastError.message : String(lastError)}`
		);
	}

	private parseDatabaseSchemaResult(result: any): DatabaseSchemaIndex {
		const columnsByTable: Record<string, Set<string>> = {};
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const primary = result?.primaryResults?.[0];
		if (!primary) {
			return { tables: [], columnsByTable: {}, columnTypesByTable: {} };
		}

		// Attempt JSON-based schema first.
		try {
			// Some drivers expose rows() as iterable, not iterator.
			const rowCandidate = primary.rows ? Array.from(primary.rows())[0] : null;
			if (rowCandidate && typeof rowCandidate === 'object') {
				// If the row itself is already an object/array with schema shape, try it.
				this.extractSchemaFromJson(rowCandidate, columnsByTable, columnTypesByTable);
				const direct = this.finalizeSchema(columnsByTable, columnTypesByTable);
				if (direct.tables.length > 0) {
					return direct;
				}

				for (const key of Object.keys(rowCandidate)) {
					const val = (rowCandidate as any)[key];
					if (val && typeof val === 'object') {
						this.extractSchemaFromJson(val, columnsByTable, columnTypesByTable);
						const finalized = this.finalizeSchema(columnsByTable, columnTypesByTable);
						if (finalized.tables.length > 0) {
							return finalized;
						}
						continue;
					}

					if (typeof val === 'string') {
						const trimmed = val.trim();
						if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
							const parsed = JSON.parse(val);
							this.extractSchemaFromJson(parsed, columnsByTable, columnTypesByTable);
							const finalized = this.finalizeSchema(columnsByTable, columnTypesByTable);
							if (finalized.tables.length > 0) {
								return finalized;
							}
						}
					}
				}
			}
		} catch {
			// ignore and fall back to tabular parsing
		}

		// Tabular fallback: try to infer TableName/ColumnName columns.
		const colNames: string[] = (primary.columns ?? []).map((c: any) => String(c.name ?? c.type ?? '')).filter(Boolean);
		const findCol = (candidates: string[]) => {
			const lowered = colNames.map(c => c.toLowerCase());
			for (const cand of candidates) {
				const idx = lowered.indexOf(cand.toLowerCase());
				if (idx >= 0) {
					return colNames[idx];
				}
			}
			return null;
		};
		const tableCol = findCol(['TableName', 'Table', 'Name']);
		const columnCol = findCol(['ColumnName', 'Column', 'Column1', 'Name1']);
		const typeCol = findCol(['ColumnType', 'Type', 'CslType', 'DataType', 'ColumnTypeName']);

		if (primary.rows) {
			for (const row of primary.rows()) {
				const tableName = tableCol ? (row as any)[tableCol] : (row as any)['TableName'];
				const columnName = columnCol ? (row as any)[columnCol] : (row as any)['ColumnName'];
				const columnType = typeCol ? (row as any)[typeCol] : (row as any)['ColumnType'];
				if (!tableName || !columnName) {
					continue;
				}
				const t = String(tableName);
				const c = String(columnName);
				columnsByTable[t] ??= new Set();
				columnsByTable[t].add(c);
				if (columnType !== undefined && columnType !== null) {
					columnTypesByTable[t] ??= {};
					columnTypesByTable[t][c] = String(columnType);
				}
			}
		}

		return this.finalizeSchema(columnsByTable, columnTypesByTable);
	}

	private buildSchemaDebug(result: any, commandUsed: string): DatabaseSchemaResult['debug'] {
		try {
			const primary = result?.primaryResults?.[0];
			const primaryColumns: string[] = (primary?.columns ?? []).map((c: any) => String(c?.name ?? c?.type ?? '')).filter(Boolean);
			let sampleRow: any = null;
			if (primary?.rows) {
				sampleRow = Array.from(primary.rows())[0] ?? null;
			}
			const sampleRowType = sampleRow === null ? 'null' : Array.isArray(sampleRow) ? 'array' : typeof sampleRow;
			const sampleRowKeys = sampleRow && typeof sampleRow === 'object' ? Object.keys(sampleRow).slice(0, 20) : [];
			let sampleRowPreview = '';
			try {
				sampleRowPreview = JSON.stringify(sampleRow)?.slice(0, 500) ?? '';
			} catch {
				sampleRowPreview = String(sampleRow)?.slice(0, 500) ?? '';
			}
			return { commandUsed, primaryColumns, sampleRowType, sampleRowKeys, sampleRowPreview };
		} catch {
			return { commandUsed };
		}
	}

	private extractSchemaFromJson(parsed: any, columnsByTable: Record<string, Set<string>>, columnTypesByTable: Record<string, Record<string, string>>) {
		if (!parsed) {
			return;
		}

		// Shape observed from `.show database schema as json`:
		// {
		//   Databases: {
		//     <DbName>: {
		//       Name: <DbName>,
		//       Tables: {
		//         <TableName>: { Name: <TableName>, OrderedColumns: [ { Name: ... } ] }
		//       }
		//     }
		//   }
		// }
		const databases = parsed.Databases ?? parsed.databases;
		if (databases && typeof databases === 'object' && !Array.isArray(databases)) {
			for (const [dbKey, dbValue] of Object.entries(databases)) {
				const dbObj: any = dbValue;
				const tablesObj = dbObj?.Tables ?? dbObj?.tables;
				if (tablesObj && typeof tablesObj === 'object' && !Array.isArray(tablesObj)) {
					for (const [tableKey, tableValue] of Object.entries(tablesObj)) {
						const table: any = tableValue;
						const tableName = table?.Name ?? table?.name ?? tableKey;
						if (!tableName) {
							continue;
						}
						const t = String(tableName);
						columnsByTable[t] ??= new Set();
						const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
						if (Array.isArray(cols)) {
							for (const col of cols) {
								const colName = (col as any)?.Name ?? (col as any)?.name;
								const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
								if (colName) {
									const c = String(colName);
									columnsByTable[t].add(c);
									if (colType !== undefined && colType !== null) {
										columnTypesByTable[t] ??= {};
										columnTypesByTable[t][c] = String(colType);
									}
								}
							}
						}
					}
				}

				// Also recurse into each database object for any alternative shapes.
				if (dbObj && typeof dbObj === 'object') {
					this.extractSchemaFromJson(dbObj, columnsByTable, columnTypesByTable);
				}
			}
			return;
		}

		// Common shapes:
		// { Tables: [ { Name, Columns: [ { Name } ] } ] }
		// { tables: [ ... ] }
		const tables = parsed.Tables ?? parsed.tables ?? parsed.databaseSchema?.Tables ?? parsed.databaseSchema?.tables;
		if (Array.isArray(tables)) {
			for (const table of tables) {
				const tableName = table?.Name ?? table?.name;
				if (!tableName) {
					continue;
				}
				const t = String(tableName);
				columnsByTable[t] ??= new Set();
				const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
				if (Array.isArray(cols)) {
					for (const col of cols) {
						const colName = col?.Name ?? col?.name;
						const colType = col?.Type ?? col?.type ?? col?.CslType ?? col?.cslType ?? col?.DataType ?? col?.dataType;
						if (colName) {
							const c = String(colName);
							columnsByTable[t].add(c);
							if (colType !== undefined && colType !== null) {
								columnTypesByTable[t] ??= {};
								columnTypesByTable[t][c] = String(colType);
							}
						}
					}
				}
			}
			return;
		}

		// Another common shape: Tables is a dictionary/object map, not an array.
		if (tables && typeof tables === 'object' && !Array.isArray(tables)) {
			for (const [tableKey, tableValue] of Object.entries(tables)) {
				const table: any = tableValue;
				const tableName = table?.Name ?? table?.name ?? tableKey;
				if (!tableName) {
					continue;
				}
				const t = String(tableName);
				columnsByTable[t] ??= new Set();
				const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
				if (Array.isArray(cols)) {
					for (const col of cols) {
						const colName = (col as any)?.Name ?? (col as any)?.name;
						const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
						if (colName) {
							const c = String(colName);
							columnsByTable[t].add(c);
							if (colType !== undefined && colType !== null) {
								columnTypesByTable[t] ??= {};
								columnTypesByTable[t][c] = String(colType);
							}
						}
					}
				}
			}
			return;
		}

		// If unknown shape, attempt recursive walk looking for {Name, Columns:[{Name}]} patterns.
		if (typeof parsed === 'object') {
			for (const value of Object.values(parsed)) {
				if (Array.isArray(value) || (value && typeof value === 'object')) {
					this.extractSchemaFromJson(value, columnsByTable, columnTypesByTable);
				}
			}
		}
	}

	private finalizeSchema(columnsByTable: Record<string, Set<string>>, columnTypesByTable: Record<string, Record<string, string>>): DatabaseSchemaIndex {
		const tables = Object.keys(columnsByTable).sort((a, b) => a.localeCompare(b));
		const out: Record<string, string[]> = {};
		for (const t of tables) {
			out[t] = Array.from(columnsByTable[t]).sort((a, b) => a.localeCompare(b));
		}
		return { tables, columnsByTable: out, columnTypesByTable };
	}

	dispose() {
		this.clients.clear();
	}
}
