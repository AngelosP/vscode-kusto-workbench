import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient } from './kustoClient';
import { classifyCachedSchema, SCHEMA_CACHE_TTL_MS, SCHEMA_CACHE_VERSION } from './schemaCache';
import { getAutocompleteSchemaSignature, getSchemaSummary } from './schemaIndexUtils';
import {
	STORAGE_KEYS,
	CachedSchemaEntry
} from './queryEditorTypes';


// ── SchemaServiceHost interface ──

export interface SchemaServiceHost {
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly connectionManager: ConnectionManager;
	readonly output: vscode.OutputChannel;
	postMessage(message: unknown): void;
	formatQueryExecutionErrorForUser(error: unknown, connection: KustoConnection, database?: string): string;
	findConnection(connectionId: string): KustoConnection | undefined;
}

type SchemaPrefetchOptions = {
	cacheOnly?: boolean;
	silent?: boolean;
	reason?: string;
};

type BackgroundSchemaRefreshListener = {
	connection: KustoConnection;
	connectionId: string;
	database: string;
	boxId: string;
	requestToken?: string;
	cachedSignature?: string;
	cachedHasRawSchemaJson: boolean;
	forceRefresh: boolean;
	silent?: boolean;
	reason?: string;
};


// ── SchemaService class ──

export class SchemaService {
	private readonly backgroundSchemaRefreshes = new Map<string, { listeners: BackgroundSchemaRefreshListener[]; promise: Promise<void> }>();

	constructor(private readonly host: SchemaServiceHost) {
		void this.migrateCachedSchemasToDiskOnce();
	}

	private postSchemaData(args: {
		boxId: string;
		connectionId: string;
		database: string;
		clusterUrl: string;
		requestToken?: string;
		schema: DatabaseSchemaIndex;
		meta?: Record<string, unknown>;
	}): void {
		const summary = getSchemaSummary(args.schema);
		this.host.postMessage({
			type: 'schemaData',
			boxId: args.boxId,
			connectionId: args.connectionId,
			database: args.database,
			clusterUrl: args.clusterUrl,
			requestToken: args.requestToken,
			schema: args.schema,
			schemaMeta: {
				...summary,
				schemaSignature: getAutocompleteSchemaSignature(args.schema),
				...args.meta,
			}
		});
	}

	private postSilentSchemaMiss(connectionId: string, database: string, boxId: string, requestToken: string | undefined, options: SchemaPrefetchOptions): void {
		this.host.postMessage({
			type: 'schemaError',
			boxId,
			connectionId,
			database,
			requestToken,
			cacheOnly: !!options.cacheOnly,
			silent: !!options.silent,
			error: 'No cached schema is available.'
		});
	}

	private scheduleBackgroundSchemaRefresh(cacheKey: string, listener: BackgroundSchemaRefreshListener): void {
		const existing = this.backgroundSchemaRefreshes.get(cacheKey);
		if (existing) {
			existing.listeners.push(listener);
			return;
		}

		const listeners: BackgroundSchemaRefreshListener[] = [listener];
		const promise = (async () => {
			try {
				const result = await this.host.kustoClient.getDatabaseSchema(listener.connection, listener.database, true);
				const schema = result.schema;
				const timestamp = result.fromCache
					? Date.now() - (result.cacheAgeMs ?? 0)
					: Date.now();
				await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

				const freshSignature = getAutocompleteSchemaSignature(schema);
				const freshHasRawSchemaJson = !!schema.rawSchemaJson;
				const snapshot = listeners.slice();
				for (const item of snapshot) {
					if (item.boxId.startsWith('__schema_req__')) {
						continue;
					}
					const autocompleteChanged = !!item.cachedSignature && item.cachedSignature !== freshSignature;
					const rawCapabilityImproved = !item.cachedHasRawSchemaJson && freshHasRawSchemaJson;
					const workerUpdateNeeded = autocompleteChanged || rawCapabilityImproved || item.forceRefresh;
					this.postSchemaData({
						boxId: item.boxId,
						connectionId: item.connectionId,
						database: item.database,
						clusterUrl: item.connection.clusterUrl,
						requestToken: item.requestToken,
						schema,
						meta: {
							fromCache: result.fromCache,
							cacheAgeMs: result.cacheAgeMs,
							debug: result.debug,
							forceRefresh: item.forceRefresh,
							deliveryKind: 'fresh',
							cacheState: 'fresh',
							isBackgroundRefresh: true,
							refreshState: 'completed',
							refreshReason: item.reason || 'stale-cache',
							workerUpdateNeeded,
							autocompleteChanged,
							rawCapabilityImproved,
							silent: !!item.silent,
						}
					});
				}
			} catch (error) {
				const rawMessage = error instanceof Error ? error.message : String(error);
				this.host.output.appendLine(`[schema] background refresh failed db=${listener.database}: ${rawMessage}`);
				const snapshot = listeners.slice();
				for (const item of snapshot) {
					if (!item.forceRefresh) {
						continue;
					}
					try {
						const userMessage = this.host.formatQueryExecutionErrorForUser(error, item.connection, item.database);
						void vscode.window.showWarningMessage(`Failed to refresh schema for ${item.database}. Using cached schema for autocomplete.`, 'More Info').then(selection => {
							if (selection === 'More Info') {
								void vscode.window.showInformationMessage(userMessage, { modal: true });
							}
						});
					} catch {
						// ignore warning formatting failures
					}
				}
			} finally {
				this.backgroundSchemaRefreshes.delete(cacheKey);
			}
		})();

		this.backgroundSchemaRefreshes.set(cacheKey, { listeners, promise });
		void promise;
	}

	// ── Disk cache infrastructure ──

	private getSchemaCacheDirUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.host.context.globalStorageUri, 'schemaCache');
	}

	private getSchemaCacheFileUri(cacheKey: string): vscode.Uri {
		const hash = crypto.createHash('sha1').update(cacheKey, 'utf8').digest('hex');
		return vscode.Uri.joinPath(this.getSchemaCacheDirUri(), `${hash}.json`);
	}

	async getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined> {
		try {
			const fileUri = this.getSchemaCacheFileUri(cacheKey);
			const buf = await vscode.workspace.fs.readFile(fileUri);
			const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as Partial<CachedSchemaEntry>;
			if (!parsed || !parsed.schema || typeof parsed.timestamp !== 'number') {
				return undefined;
			}
			const version = typeof parsed.version === 'number' && isFinite(parsed.version) ? parsed.version : 0;
			return { schema: parsed.schema, timestamp: parsed.timestamp, version };
		} catch {
			return undefined;
		}
	}

	async saveCachedSchemaToDisk(cacheKey: string, entry: CachedSchemaEntry): Promise<void> {
		const dir = this.getSchemaCacheDirUri();
		await vscode.workspace.fs.createDirectory(dir);
		const fileUri = this.getSchemaCacheFileUri(cacheKey);
		const pipeIdx = cacheKey.indexOf('|');
		const enriched: CachedSchemaEntry = {
			...entry,
			clusterUrl: entry.clusterUrl ?? (pipeIdx >= 0 ? cacheKey.slice(0, pipeIdx) : undefined),
			database: entry.database ?? (pipeIdx >= 0 ? cacheKey.slice(pipeIdx + 1) : undefined)
		};
		const json = JSON.stringify(enriched);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(json, 'utf8'));
	}

	private async migrateCachedSchemasToDiskOnce(): Promise<void> {
		try {
			const already = this.host.context.globalState.get<boolean>(STORAGE_KEYS.cachedSchemasMigratedToDisk);
			if (already) {
				return;
			}
			// Legacy cache stored in globalState (pre disk-cache migration) did not include a schema version.
			const legacy = this.host.context.globalState.get<Record<string, { schema: DatabaseSchemaIndex; timestamp: number }> | undefined>(
				STORAGE_KEYS.cachedSchemas
			);
			if (legacy && typeof legacy === 'object') {
				const entries = Object.entries(legacy)
					.filter(([, v]) => !!v && typeof v === 'object' && !!(v as any).schema)
					.sort((a, b) => (b[1].timestamp ?? 0) - (a[1].timestamp ?? 0))
					.slice(0, 25);
				for (const [key, entry] of entries) {
					try {
						await this.saveCachedSchemaToDisk(key, { schema: entry.schema, timestamp: entry.timestamp, version: SCHEMA_CACHE_VERSION });
					} catch {
						// ignore
					}
				}
			}
			// Clear legacy cache to stop VS Code "large extension state" warnings.
			await this.host.context.globalState.update(STORAGE_KEYS.cachedSchemas, undefined);
			await this.host.context.globalState.update(STORAGE_KEYS.cachedSchemasMigratedToDisk, true);
		} catch {
			// ignore
		}
	}

	// ── Schema prefetch ──

	async prefetchSchema(
		connectionId: string,
		database: string,
		boxId: string,
		forceRefresh: boolean,
		requestToken?: string,
		options: SchemaPrefetchOptions = {}
	): Promise<void> {
		const connection = this.host.findConnection(connectionId);
		if (!connection || !database) {
			return;
		}

		const cacheKey = `${connection.clusterUrl}|${database}`;
		// IMPORTANT: Never delete persisted schema cache up-front.
		// If a refresh fails (e.g. offline/VPN), we want to keep using the cached schema
		// for autocomplete until the next successful refresh.

		try {
			this.host.output.appendLine(
				`[schema] request connectionId=${connectionId} db=${database} forceRefresh=${forceRefresh} cacheOnly=${!!options.cacheOnly}`
			);

			// Read persisted cache once so we can (a) use it when fresh, and (b) fall back to it on errors.
			const cached = await this.getCachedSchemaFromDisk(cacheKey);
			const cachedState = classifyCachedSchema(cached);
			const cachedAgeMs = cachedState.cacheAgeMs;
			const cachedSignature = cached?.schema ? getAutocompleteSchemaSignature(cached.schema) : undefined;
			const cachedHasRawSchemaJson = !!cached?.schema?.rawSchemaJson;

			if (options.cacheOnly) {
				if (cached?.schema) {
					this.host.output.appendLine(`[schema] loaded (cache-only) db=${database}`);
					this.postSchemaData({
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						requestToken,
						schema: cached.schema,
						meta: {
							fromCache: true,
							cacheAgeMs: cachedAgeMs,
							deliveryKind: 'cache-only',
							cacheState: cachedState.isFresh && cachedState.isLatestVersion ? 'fresh' : 'stale',
							isStale: !(cachedState.isFresh && cachedState.isLatestVersion),
							refreshState: 'none',
							workerUpdateNeeded: true,
							cacheOnly: true,
							silent: !!options.silent,
						}
					});
					return;
				}
				this.host.output.appendLine(`[schema] cache-only miss db=${database}`);
				this.postSilentSchemaMiss(connectionId, database, boxId, requestToken, options);
				return;
			}

			// Default path: use persisted cache when it's still fresh.
			if (!forceRefresh && cached && cachedState.isFresh && cachedState.isLatestVersion) {
				const schema = cached.schema;
				const summary = getSchemaSummary(schema);

				this.host.output.appendLine(
					`[schema] loaded (persisted cache) db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount}`
				);
				this.postSchemaData({
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					meta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						deliveryKind: 'cache',
						cacheState: 'fresh',
						isStale: false,
						refreshState: 'none',
						workerUpdateNeeded: true,
					}
				});
				return;
			}

			// If we have cached data (even if stale or outdated version) and this is NOT a force refresh,
			// return the cached data immediately and refresh in the background.
			if (!forceRefresh && cached) {
				const schema = cached.schema;
				const summary = getSchemaSummary(schema);

				this.host.output.appendLine(
					`[schema] loaded (persisted cache, stale/outdated) db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount}`
				);
				this.postSchemaData({
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					meta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						deliveryKind: 'cache',
						cacheState: cachedState.isLatestVersion ? 'stale' : 'outdated',
						isStale: true,
						refreshState: 'scheduled',
						refreshReason: cachedState.isLatestVersion ? 'stale-cache' : 'cache-version-mismatch',
						workerUpdateNeeded: true,
					}
				});
				this.scheduleBackgroundSchemaRefresh(cacheKey, {
					connection,
					connectionId,
					database,
					boxId,
					requestToken,
					cachedSignature,
					cachedHasRawSchemaJson,
					forceRefresh: false,
					reason: cachedState.isLatestVersion ? 'stale-cache' : 'cache-version-mismatch',
				});
				return;
			}

			const result = await this.host.kustoClient.getDatabaseSchema(connection, database, forceRefresh);
			const schema = result.schema;

			const summary = getSchemaSummary(schema);

			this.host.output.appendLine(
				`[schema] loaded db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount} fromCache=${result.fromCache}`
			);

			// Persist schema across VS Code sessions.
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });
			if (summary.tablesCount === 0 || summary.columnsCount === 0) {
				const d = result.debug;
				if (d) {
					this.host.output.appendLine(`[schema] debug command=${d.commandUsed ?? ''}`);
					this.host.output.appendLine(`[schema] debug columns=${(d.primaryColumns ?? []).join(', ')}`);
					this.host.output.appendLine(
						`[schema] debug sampleRowType=${d.sampleRowType ?? ''} keys=${(d.sampleRowKeys ?? []).join(', ')}`
					);
					this.host.output.appendLine(`[schema] debug sampleRowPreview=${d.sampleRowPreview ?? ''}`);
				}
			}

			this.postSchemaData({
				boxId,
				connectionId,
				database,
				clusterUrl: connection.clusterUrl,
				requestToken,
				schema,
				meta: {
					fromCache: result.fromCache,
					cacheAgeMs: result.cacheAgeMs,
					debug: result.debug,
					forceRefresh,
					deliveryKind: result.fromCache ? 'memory-cache' : 'fresh',
					cacheState: 'fresh',
					isStale: false,
					refreshState: 'completed',
					workerUpdateNeeded: true,
				}
			});
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			this.host.output.appendLine(`[schema] error db=${database}: ${rawMessage}`);

			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);
			try {
				const cached = await this.getCachedSchemaFromDisk(cacheKey);
				if (cached && cached.schema) {
					const schema = cached.schema;
					const summary = getSchemaSummary(schema);
					const hasRawSchemaJson = !!schema.rawSchemaJson;

					this.host.output.appendLine(
						`[schema] using cached schema after failure db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount} hasRawSchemaJson=${hasRawSchemaJson}`
					);
					this.postSchemaData({
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						requestToken,
						schema,
						meta: {
							fromCache: true,
							cacheAgeMs: Date.now() - cached.timestamp,
							isFailoverToCache: true,
							hasRawSchemaJson,
							forceRefresh,
							deliveryKind: 'cache-failover',
							cacheState: 'stale',
							isStale: true,
							refreshState: 'failed',
							workerUpdateNeeded: true,
						}
					});

					const notificationMessage = hasRawSchemaJson
						? `Failed to refresh schema for ${database}. Using cached schema for autocomplete.`
						: `Failed to refresh schema for ${database}. Cached schema is outdated and autocomplete may not work.`;
					void vscode.window.showWarningMessage(notificationMessage, 'More Info').then(selection => {
						if (selection === 'More Info') {
							void vscode.window.showInformationMessage(userMessage, { modal: true });
						}
					});
					return;
				}
			} catch {
				// ignore and fall through to posting schemaError
			}

			const action = forceRefresh ? 'refresh' : 'load';
			void vscode.window.showErrorMessage(`Failed to ${action} schema for ${database}.`, 'More Info').then(selection => {
				if (selection === 'More Info') {
					void vscode.window.showInformationMessage(userMessage, { modal: true });
				}
			});
			this.host.postMessage({
				type: 'schemaError',
				boxId,
				connectionId,
				database,
				requestToken,
				error: `Failed to ${action} schema.\n${userMessage}`
			});
		}
	}

	// ── Cross-cluster schema ──

	async handleCrossClusterSchemaRequest(
		clusterName: string,
		database: string,
		boxId: string,
		requestToken: string
	): Promise<void> {
		// Normalize the cluster name to a URL
		let clusterUrl = clusterName.trim();
		if (clusterUrl && !clusterUrl.includes('.')) {
			clusterUrl = `https://${clusterUrl}.kusto.windows.net`;
		} else if (clusterUrl && !clusterUrl.startsWith('https://') && !clusterUrl.startsWith('http://')) {
			clusterUrl = `https://${clusterUrl}`;
		}

		// Find a connection that matches this cluster URL
		const connections = this.host.connectionManager.getConnections();

		const connection = connections.find(c => {
			const connUrl = String(c.clusterUrl || '').trim().toLowerCase();
			const targetUrl = clusterUrl.toLowerCase();
			if (connUrl === targetUrl) { return true; }
			try {
				const connHostname = new URL(connUrl.startsWith('http') ? connUrl : `https://${connUrl}`).hostname;
				const targetHostname = new URL(targetUrl).hostname;
				return connHostname === targetHostname;
			} catch {
				return false;
			}
		});

		if (!connection) {
			this.host.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				error: `No connection available for cluster "${clusterName}". Add a connection to get autocomplete support.`
			});
			return;
		}

		try {
			const cacheKey = `${connection.clusterUrl}|${database}`;

			const cached = await this.getCachedSchemaFromDisk(cacheKey);
			const cachedAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			const cachedIsFresh = !!(cached && typeof cachedAgeMs === 'number' && cachedAgeMs < SCHEMA_CACHE_TTL_MS);

			if (cached && cachedIsFresh && cached.schema.rawSchemaJson) {
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				return;
			}

			if (cached && cached.schema.rawSchemaJson) {
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				return;
			}

			const result = await this.host.kustoClient.getDatabaseSchema(connection, database, false);
			const schema = result.schema;

			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

			if (schema.rawSchemaJson) {
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					database,
					boxId,
					requestToken,
					rawSchemaJson: schema.rawSchemaJson
				});
			} else {
				this.host.postMessage({
					type: 'crossClusterSchemaError',
					clusterName,
					database,
					boxId,
					requestToken,
					error: `Schema loaded but missing raw format required for autocomplete.`
				});
			}
		} catch (error) {
			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);
			this.host.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				error: `Failed to load schema for ${clusterName}.${database}.\n${userMessage}`
			});
		}
	}

	// ── Tool orchestrator schema refresh ──

	async refreshSchemaForTools(clusterUrl: string): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const connections = this.host.connectionManager.getConnections();
		const normalizedInput = clusterUrl.replace(/\/+$/, '').toLowerCase();
		const connection = connections.find(c => c.clusterUrl.replace(/\/+$/, '').toLowerCase() === normalizedInput);
		if (!connection) {
			const ephemeral: KustoConnection = { id: `ephemeral_${Date.now()}`, name: clusterUrl, clusterUrl };
			return this.refreshSchemaForConnection(ephemeral);
		}
		return this.refreshSchemaForConnection(connection);
	}

	private async refreshSchemaForConnection(connection: KustoConnection): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> = [];
		try {
			const databases = await this.host.kustoClient.getDatabases(connection, true);
			if (databases.length === 0) {
				return { schemas: [], error: 'No databases found on this cluster, or insufficient permissions.' };
			}

			const errors: string[] = [];
			for (const db of databases) {
				try {
					const result = await this.host.kustoClient.getDatabaseSchema(connection, db, true);
					const schema = result.schema;

					const cacheKey = `${connection.clusterUrl.replace(/\/+$/, '')}|${db}`;
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });

					const tables = schema.tables || [];
					const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : f.name || '').filter(Boolean);
					schemas.push({
						clusterUrl: connection.clusterUrl,
						database: db,
						tables,
						functions
					});
				} catch (dbErr) {
					errors.push(`${db}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
				}
			}

			if (errors.length > 0 && schemas.length === 0) {
				return { schemas, error: `Failed to refresh schema for all databases: ${errors.join('; ')}` };
			}
			if (errors.length > 0) {
				return { schemas, error: `Some databases failed: ${errors.join('; ')}` };
			}
			return { schemas };
		} catch (err) {
			return { schemas, error: `Failed to refresh schema: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
}
