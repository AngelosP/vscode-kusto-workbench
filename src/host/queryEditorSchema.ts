import * as vscode from 'vscode';
import * as crypto from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient } from './kustoClient';
import { SCHEMA_CACHE_VERSION } from './schemaCache';
import { countColumns } from './schemaIndexUtils';
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


// ── SchemaService class ──

export class SchemaService {
	private readonly SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

	constructor(private readonly host: SchemaServiceHost) {
		void this.migrateCachedSchemasToDiskOnce();
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
		requestToken?: string
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
				`[schema] request connectionId=${connectionId} db=${database} forceRefresh=${forceRefresh}`
			);

			// Read persisted cache once so we can (a) use it when fresh, and (b) fall back to it on errors.
			const cached = await this.getCachedSchemaFromDisk(cacheKey);
			const cachedAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			const cachedIsFresh = !!(cached && typeof cachedAgeMs === 'number' && cachedAgeMs < this.SCHEMA_CACHE_TTL_MS);
			const cachedIsLatest = !!(cached && (cached.version ?? 0) === SCHEMA_CACHE_VERSION);

			// Default path: use persisted cache when it's still fresh.
			if (!forceRefresh && cached && cachedIsFresh && cachedIsLatest) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);

				this.host.output.appendLine(
					`[schema] loaded (persisted cache) db=${database} tables=${tablesCount} columns=${columnsCount}`
				);
				this.host.postMessage({
					type: 'schemaData',
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					schemaMeta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						tablesCount,
						columnsCount,
						functionsCount: schema.functions?.length ?? 0
					}
				});
				return;
			}

			// If we have cached data (even if stale or outdated version) and this is NOT a force refresh,
			// return the cached data immediately without making a network call.
			if (!forceRefresh && cached) {
				const schema = cached.schema;
				const tablesCount = schema.tables?.length ?? 0;
				const columnsCount = countColumns(schema);

				this.host.output.appendLine(
					`[schema] loaded (persisted cache, stale/outdated) db=${database} tables=${tablesCount} columns=${columnsCount}`
				);
				this.host.postMessage({
					type: 'schemaData',
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					requestToken,
					schema,
					schemaMeta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						tablesCount,
						columnsCount,
						functionsCount: schema.functions?.length ?? 0
					}
				});
				return;
			}

			const result = await this.host.kustoClient.getDatabaseSchema(connection, database, forceRefresh);
			const schema = result.schema;

			const tablesCount = schema.tables?.length ?? 0;
			const columnsCount = countColumns(schema);

			this.host.output.appendLine(
				`[schema] loaded db=${database} tables=${tablesCount} columns=${columnsCount} fromCache=${result.fromCache}`
			);

			// Persist schema across VS Code sessions.
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			await this.saveCachedSchemaToDisk(cacheKey, { schema, timestamp, version: SCHEMA_CACHE_VERSION });
			if (tablesCount === 0 || columnsCount === 0) {
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

			this.host.postMessage({
				type: 'schemaData',
				boxId,
				connectionId,
				database,
				clusterUrl: connection.clusterUrl,
				requestToken,
				schema,
				schemaMeta: {
					fromCache: result.fromCache,
					cacheAgeMs: result.cacheAgeMs,
					tablesCount,
					columnsCount,
					functionsCount: schema.functions?.length ?? 0,
					debug: result.debug,
					forceRefresh
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
					const tablesCount = schema.tables?.length ?? 0;
					const columnsCount = countColumns(schema);
					const hasRawSchemaJson = !!schema.rawSchemaJson;

					this.host.output.appendLine(
						`[schema] using cached schema after failure db=${database} tables=${tablesCount} columns=${columnsCount} hasRawSchemaJson=${hasRawSchemaJson}`
					);
					this.host.postMessage({
						type: 'schemaData',
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						requestToken,
						schema,
						schemaMeta: {
							fromCache: true,
							cacheAgeMs: Date.now() - cached.timestamp,
							tablesCount,
							columnsCount,
							functionsCount: schema.functions?.length ?? 0,
							isFailoverToCache: true,
							hasRawSchemaJson
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
			const cachedIsFresh = !!(cached && typeof cachedAgeMs === 'number' && cachedAgeMs < this.SCHEMA_CACHE_TTL_MS);

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
