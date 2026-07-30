import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { DatabaseSchemaIndex, KustoQueryClient, normalizeClusterEndpoint } from './kustoClient';
import {
	classifyCachedSchema,
	readCachedSchemaFromDisk,
	SCHEMA_CACHE_TTL_MS,
	SCHEMA_CACHE_VERSION,
	schemaCacheKey,
	type SchemaCacheGeneration,
	writeCachedSchemaToDisk,
} from './schemaCache';
import { ensureRawSchemaJson, getAutocompleteSchemaSignature, getSchemaSummary } from './schemaIndexUtils';
import {
	STORAGE_KEYS,
	CachedSchemaEntry
} from './queryEditorTypes';
import { kustoClusterKey, kustoDatabaseKey } from '../shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey, resolveKustoConnection, resolveStrictKustoConnection } from '../shared/kustoAuth';
import { databaseListTraceRef, getDatabaseListErrorDetails } from './databaseListTrace';
import type { WorkbenchLogger } from './workbenchLogger';
import type { KustoEditorLifecycleIdentity } from '../shared/kustoSchemaLifecycle';


// ── SchemaServiceHost interface ──

export interface SchemaServiceHost {
	readonly context: vscode.ExtensionContext;
	readonly kustoClient: KustoQueryClient;
	readonly connectionManager: ConnectionManager;
	readonly output: WorkbenchLogger;
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
	connectionIdentity: string;
	connectionId: string;
	database: string;
	accountPartition: string;
	boxId: string;
	requestToken?: string;
	cachedSignature?: string;
	cachedHasRawSchemaJson: boolean;
	forceRefresh: boolean;
	silent?: boolean;
	reason?: string;
	lifecycle?: KustoEditorLifecycleIdentity;
};

type SupplementalFailureKind = 'missing-connection' | 'ambiguous-connection' | 'auth-required' | 'not-found' | 'fetch-failed' | 'invalid-schema';

function supplementalFailureKind(error: unknown, isAuthenticationError?: (error: unknown) => boolean): SupplementalFailureKind {
	if (isAuthenticationError?.(error)) return 'auth-required';
	const details = getDatabaseListErrorDetails(error);
	if (details.status === 401 || details.status === 403 || /^AADSTS/i.test(details.code || '')) return 'auth-required';
	if (details.status === 404) return 'not-found';
	return 'fetch-failed';
}

function requireWorkerReadySchema(schema: DatabaseSchemaIndex, database: string): DatabaseSchemaIndex {
	const normalized = ensureRawSchemaJson(schema, database);
	if (!normalized.rawSchemaJson) {
		throw new Error(`Schema response for ${database} is not usable for autocomplete.`);
	}
	return normalized;
}


// ── SchemaService class ──

export class SchemaService {
	private readonly backgroundSchemaRefreshes = new Map<string, { listeners: BackgroundSchemaRefreshListener[]; promise: Promise<void> }>();

	constructor(private readonly host: SchemaServiceHost) {
		void this.migrateCachedSchemasToDiskOnce();
	}

	private isConnectionIdentityCurrent(connectionId: string, capturedIdentity: string): boolean {
		const current = this.host.findConnection(connectionId);
		if (!current) return false;
		try {
			return getKustoConnectionIdentityKey(current.clusterUrl, current.authorityId) === capturedIdentity;
		} catch {
			return false;
		}
	}

	private postSchemaData(args: {
		boxId: string;
		connectionId: string;
		database: string;
		clusterUrl: string;
		accountPartition: string;
		requestToken?: string;
		schema: DatabaseSchemaIndex;
		meta?: Record<string, unknown>;
		lifecycle?: KustoEditorLifecycleIdentity;
	}): void {
		const schema = requireWorkerReadySchema(args.schema, args.database);
		const summary = getSchemaSummary(schema);
		this.host.postMessage({
			type: 'schemaData',
			boxId: args.boxId,
			connectionId: args.connectionId,
			database: args.database,
			clusterUrl: args.clusterUrl,
			accountPartition: args.accountPartition,
			requestToken: args.requestToken,
			...(args.lifecycle || {}),
			schema,
			schemaMeta: {
				...summary,
				schemaSignature: getAutocompleteSchemaSignature(schema),
				...args.meta,
			}
		});
	}

	private postSilentSchemaMiss(connectionId: string, database: string, boxId: string, requestToken: string | undefined, options: SchemaPrefetchOptions, lifecycle?: KustoEditorLifecycleIdentity): void {
		this.host.postMessage({
			type: 'schemaError',
			boxId,
			connectionId,
			database,
			requestToken,
			...(lifecycle || {}),
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
				const result = await this.host.kustoClient.getDatabaseSchema(listener.connection, listener.database, true, {
					allowInteractive: false,
					source: 'background-refresh',
				});
				if (!this.isConnectionIdentityCurrent(listener.connectionId, listener.connectionIdentity)) return;
				const accountPartition = result.accountPartition;
				if (!accountPartition || accountPartition !== listener.accountPartition) return;
				const schema = requireWorkerReadySchema(result.schema, listener.database);
				const timestamp = result.fromCache
					? Date.now() - (result.cacheAgeMs ?? 0)
					: Date.now();
				try {
					await this.saveCachedSchemaToDisk(cacheKey, {
						schema,
						timestamp,
						version: SCHEMA_CACHE_VERSION,
						clusterUrl: listener.connection.clusterUrl,
						database: listener.database,
						connectionId: listener.connectionId,
						accountPartition,
					}, result.cacheGeneration);
				} catch (cacheError) {
					this.host.output.warn(`[schema] failed to persist background schema db=${listener.database}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
				}

				const freshSignature = getAutocompleteSchemaSignature(schema);
				const freshHasRawSchemaJson = !!schema.rawSchemaJson;
				const snapshot = listeners.slice();
				for (const item of snapshot) {
					if (!this.isConnectionIdentityCurrent(item.connectionId, item.connectionIdentity)) continue;
					if (!item.lifecycle && item.boxId.startsWith('__schema_req__')) {
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
						accountPartition: item.accountPartition,
						requestToken: item.requestToken,
						lifecycle: item.lifecycle,
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
				this.host.output.warn(`[schema] background refresh failed db=${listener.database}: ${rawMessage}`);
				const snapshot = listeners.slice();
				for (const item of snapshot) {
					if (!this.isConnectionIdentityCurrent(item.connectionId, item.connectionIdentity)) continue;
					if (item.lifecycle || !item.boxId.startsWith('__schema_req__')) {
						this.host.postMessage({
							type: 'schemaError',
							boxId: item.boxId,
							connectionId: item.connectionId,
							database: item.database,
							requestToken: item.requestToken,
							...(item.lifecycle || {}),
							silent: true,
							isBackgroundRefresh: true,
							refreshState: 'failed',
							hasUsableFallback: item.cachedHasRawSchemaJson,
							error: 'Background schema refresh failed.',
						});
					}
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

	async getCachedSchemaFromDisk(cacheKey: string): Promise<CachedSchemaEntry | undefined> {
		const cached = await readCachedSchemaFromDisk(this.host.context.globalStorageUri, cacheKey);
		return classifyCachedSchema(cached).isUsable ? cached : undefined;
	}

	private async getCachedSchemaFromDiskByCluster(connection: KustoConnection, database: string, accountPartition: string | undefined): Promise<CachedSchemaEntry | undefined> {
		if (!accountPartition) return undefined;
		const cached = await this.getCachedSchemaFromDisk(schemaCacheKey(connection.clusterUrl, database, connection.id, accountPartition));
		if (!cached
			|| cached.connectionId !== connection.id
			|| cached.accountPartition !== accountPartition
			|| kustoDatabaseKey(cached.clusterUrl, cached.database) !== kustoDatabaseKey(connection.clusterUrl, database)) {
			return undefined;
		}
		const schema = ensureRawSchemaJson(cached.schema, database);
		return schema.rawSchemaJson ? { ...cached, schema } : undefined;
	}

	async saveCachedSchemaToDisk(cacheKey: string, entry: CachedSchemaEntry, expectedGeneration?: SchemaCacheGeneration): Promise<void> {
		await writeCachedSchemaToDisk(this.host.context.globalStorageUri, cacheKey, {
			...entry,
			schema: requireWorkerReadySchema(entry.schema, entry.database || ''),
		}, expectedGeneration);
	}

	private async migrateCachedSchemasToDiskOnce(): Promise<void> {
		try {
			const already = this.host.context.globalState.get<boolean>(STORAGE_KEYS.cachedSchemasMigratedToDisk);
			if (already) {
				return;
			}
			// Unpartitioned legacy schemas cannot be assigned to a principal safely.
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
		options: SchemaPrefetchOptions = {},
		lifecycle?: KustoEditorLifecycleIdentity,
	): Promise<void> {
		const connection = this.host.findConnection(connectionId);
		if (!connection || !database) {
			this.host.postMessage({
				type: 'schemaError',
				boxId,
				connectionId,
				database,
				requestToken,
				...(lifecycle || {}),
				cacheOnly: !!options.cacheOnly,
				silent: !!options.silent,
				error: connection ? 'No database is selected.' : 'The selected Kusto connection is no longer available.',
			});
			return;
		}
		let connectionIdentity = '';
		try {
			connectionIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
		} catch {
			this.host.postMessage({
				type: 'schemaError', boxId, connectionId, database, requestToken, ...(lifecycle || {}),
				cacheOnly: !!options.cacheOnly, silent: !!options.silent,
				error: 'The saved Kusto connection has an invalid Tenant / Authority ID.',
			});
			return;
		}
		const isConnectionCurrent = () => this.isConnectionIdentityCurrent(connection.id, connectionIdentity);

		const initialAccountPartition = this.host.kustoClient.getAccountPartition(connection);
		const cacheKey = initialAccountPartition
			? schemaCacheKey(connection.clusterUrl, database, connection.id, initialAccountPartition)
			: '';
		// IMPORTANT: Never delete persisted schema cache up-front.
		// If a refresh fails (e.g. offline/VPN), we want to keep using the cached schema
		// for autocomplete until the next successful refresh.

		try {
			this.host.output.info(
				`[schema] request connectionId=${connectionId} db=${database} forceRefresh=${forceRefresh} cacheOnly=${!!options.cacheOnly}`
			);

			// Read persisted cache once so we can (a) use it when fresh, and (b) fall back to it on errors.
			const cached = await this.getCachedSchemaFromDiskByCluster(connection, database, initialAccountPartition);
			if (!isConnectionCurrent()) return;
			const cachedState = classifyCachedSchema(cached);
			const cachedAgeMs = cachedState.cacheAgeMs;
			const cachedSignature = cached?.schema ? getAutocompleteSchemaSignature(cached.schema) : undefined;
			const cachedHasRawSchemaJson = !!cached?.schema?.rawSchemaJson;

			if (options.cacheOnly) {
				if (!isConnectionCurrent()) return;
				if (cached?.schema) {
					this.host.output.info(`[schema] loaded (cache-only) db=${database}`);
					this.postSchemaData({
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						accountPartition: initialAccountPartition!,
						requestToken,
						lifecycle,
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
				this.host.output.info(`[schema] cache-only miss db=${database}`);
				this.postSilentSchemaMiss(connectionId, database, boxId, requestToken, options, lifecycle);
				return;
			}

			// Default path: use persisted cache when it's still fresh.
			if (!forceRefresh && cached && cachedState.isFresh && cachedState.isLatestVersion) {
				if (!isConnectionCurrent()) return;
				const schema = cached.schema;
				const summary = getSchemaSummary(schema);

				this.host.output.info(
					`[schema] loaded (persisted cache) db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount}`
				);
				this.postSchemaData({
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					accountPartition: initialAccountPartition!,
					requestToken,
					lifecycle,
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
				if (!isConnectionCurrent()) return;
				const schema = cached.schema;
				const summary = getSchemaSummary(schema);

				this.host.output.info(
					`[schema] loaded (persisted cache, stale/outdated) db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount}`
				);
				this.postSchemaData({
					boxId,
					connectionId,
					database,
					clusterUrl: connection.clusterUrl,
					accountPartition: initialAccountPartition!,
					requestToken,
					lifecycle,
					schema,
					meta: {
						fromCache: true,
						cacheAgeMs: cachedAgeMs,
						deliveryKind: 'cache',
						cacheState: cachedState.isLatestVersion ? 'stale' : 'outdated',
						isStale: true,
						isBackgroundRefresh: true,
						refreshState: 'scheduled',
						refreshReason: cachedState.isLatestVersion ? 'stale-cache' : 'cache-version-mismatch',
						workerUpdateNeeded: true,
					}
				});
				this.scheduleBackgroundSchemaRefresh(cacheKey, {
					connection,
					connectionIdentity,
					connectionId,
					database,
					accountPartition: initialAccountPartition!,
					boxId,
					requestToken,
					lifecycle,
					cachedSignature,
					cachedHasRawSchemaJson,
					forceRefresh: false,
					reason: cachedState.isLatestVersion ? 'stale-cache' : 'cache-version-mismatch',
				});
				return;
			}

			const result = await this.host.kustoClient.getDatabaseSchema(connection, database, forceRefresh);
			if (!isConnectionCurrent()) return;
			const schema = requireWorkerReadySchema(result.schema, database);
			const resolvedAccountPartition = result.accountPartition;
			if (!resolvedAccountPartition) {
				throw new Error('The schema response did not include a resolved Microsoft account identity.');
			}
			const resolvedCacheKey = schemaCacheKey(connection.clusterUrl, database, connection.id, resolvedAccountPartition);

			const summary = getSchemaSummary(schema);

			this.host.output.info(
				`[schema] loaded db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount} fromCache=${result.fromCache}`
			);

			// Persist schema across VS Code sessions.
			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			try {
				await this.saveCachedSchemaToDisk(resolvedCacheKey, {
					schema,
					timestamp,
					version: SCHEMA_CACHE_VERSION,
					clusterUrl: connection.clusterUrl,
					database,
					connectionId,
					accountPartition: resolvedAccountPartition,
				}, result.cacheGeneration);
			} catch (cacheError) {
				this.host.output.warn(`[schema] failed to persist schema db=${database}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
			}
			if (!isConnectionCurrent()) return;
			if (summary.tablesCount === 0 || summary.columnsCount === 0) {
				const d = result.debug;
				if (d) {
					this.host.output.debug(`[schema] debug command=${d.commandUsed ?? ''}`);
					this.host.output.debug(`[schema] debug columns=${(d.primaryColumns ?? []).join(', ')}`);
					this.host.output.debug(
						`[schema] debug sampleRowType=${d.sampleRowType ?? ''} keys=${(d.sampleRowKeys ?? []).join(', ')}`
					);
					this.host.output.debug(`[schema] debug sampleRowPreview=${d.sampleRowPreview ?? ''}`);
				}
			}

			this.postSchemaData({
				boxId,
				connectionId,
				database,
				clusterUrl: connection.clusterUrl,
				accountPartition: resolvedAccountPartition,
				requestToken,
				lifecycle,
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
			if (!isConnectionCurrent()) return;
			const rawMessage = error instanceof Error ? error.message : String(error);
			this.host.output.error(`[schema] error db=${database}: ${rawMessage}`);

			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);
			try {
				const failoverPartition = this.host.kustoClient.getAccountPartition(connection);
				const cached = await this.getCachedSchemaFromDiskByCluster(connection, database, failoverPartition);
				if (!isConnectionCurrent()) return;
				if (cached && cached.schema) {
					const schema = cached.schema;
					const summary = getSchemaSummary(schema);
					const hasRawSchemaJson = !!schema.rawSchemaJson;

					this.host.output.warn(
						`[schema] using cached schema after failure db=${database} tables=${summary.tablesCount} columns=${summary.columnsCount} hasRawSchemaJson=${hasRawSchemaJson}`
					);
					this.postSchemaData({
						boxId,
						connectionId,
						database,
						clusterUrl: connection.clusterUrl,
						accountPartition: failoverPartition!,
						requestToken,
						lifecycle,
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
			if (!isConnectionCurrent()) return;

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
				...(lifecycle || {}),
				error: `Failed to ${action} schema.\n${userMessage}`
			});
		}
	}

	// ── Cross-cluster schema ──

	async handleCrossClusterSchemaRequest(
		clusterName: string,
		database: string,
		boxId: string,
		requestToken: string,
		requestSource: 'background' | 'autocomplete',
		traceId?: string
	): Promise<void> {
		const trace = (event: string, details: Record<string, unknown> = {}) => {
			this.host.output.trace(`[supplemental-schema:${traceId || 'none'}] host.${event} requestSource=${requestSource} clusterRef=${databaseListTraceRef(clusterName)} databaseRef=${databaseListTraceRef(database)} boxRef=${databaseListTraceRef(boxId)} tokenRef=${databaseListTraceRef(requestToken)}${Object.entries(details).map(([key, value]) => ` ${key}=${String(value)}`).join('')}`);
		};
		trace('request.start');
		const connections = this.host.connectionManager.getConnections();
		const resolution = resolveKustoConnection(connections, { clusterUrl: normalizeClusterEndpoint(clusterName) });

		if (resolution.kind !== 'matched') {
			const failureKind: SupplementalFailureKind = resolution.kind === 'ambiguous' ? 'ambiguous-connection' : 'missing-connection';
			trace('request.failed', { failureKind });
			this.host.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				requestSource,
				failureKind,
				error: resolution.kind === 'ambiguous'
					? `Multiple connections match cluster "${clusterName}". Select an authority-specific connection before loading supplemental schema.`
					: `No connection available for cluster "${clusterName}". Add a connection to get autocomplete support.`
			});
			return;
		}
		const connection = resolution.connection;
		let connectionIdentity = '';
		try {
			connectionIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
		} catch {
			this.host.postMessage({
				type: 'crossClusterSchemaError', clusterName, database, boxId, requestToken, requestSource,
				failureKind: 'auth-required', error: 'The saved Kusto connection has an invalid Tenant / Authority ID.',
			});
			return;
		}
		const isConnectionCurrent = () => this.isConnectionIdentityCurrent(connection.id, connectionIdentity);

		try {
			const initialAccountPartition = this.host.kustoClient.getAccountPartition(connection);
			const cacheKey = initialAccountPartition
				? schemaCacheKey(connection.clusterUrl, database, connection.id, initialAccountPartition)
				: '';

			const cached = await this.getCachedSchemaFromDiskByCluster(connection, database, initialAccountPartition);
			if (!isConnectionCurrent()) return;
			const cachedAgeMs = cached ? Date.now() - cached.timestamp : undefined;
			const cachedIsLatestVersion = cached?.version === SCHEMA_CACHE_VERSION;
			const cachedIsFresh = !!(cached && cachedIsLatestVersion && typeof cachedAgeMs === 'number' && cachedAgeMs < SCHEMA_CACHE_TTL_MS);

			if (cached && cachedIsFresh && cached.schema.rawSchemaJson) {
				trace('cache.hit', { deliverySource: 'disk-cache-fresh', cacheAgeMs: cachedAgeMs });
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					connectionId: connection.id,
					accountPartition: initialAccountPartition,
					database,
					boxId,
					requestToken,
					requestSource,
					deliverySource: 'disk-cache-fresh',
					cacheAgeMs: cachedAgeMs,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				return;
			}

			if (cached && cachedIsLatestVersion && cached.schema.rawSchemaJson && requestSource === 'background') {
				trace('cache.hit', { deliverySource: 'disk-cache-stale', cacheAgeMs: cachedAgeMs });
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					connectionId: connection.id,
					accountPartition: initialAccountPartition,
					database,
					boxId,
					requestToken,
					requestSource,
					deliverySource: 'disk-cache-stale',
					cacheAgeMs: cachedAgeMs,
					rawSchemaJson: cached.schema.rawSchemaJson
				});
				void (async () => {
					try {
						const result = await this.host.kustoClient.getDatabaseSchema(connection, database, true, {
							allowInteractive: false,
							traceId,
							source: 'supplemental-background-refresh',
						});
						if (!isConnectionCurrent()) return;
						const freshSchema = requireWorkerReadySchema(result.schema, database);
						const resolvedAccountPartition = result.accountPartition;
						if (!resolvedAccountPartition || resolvedAccountPartition !== initialAccountPartition) return;
						const timestamp = result.fromCache
							? Date.now() - (result.cacheAgeMs ?? 0)
							: Date.now();
						if (freshSchema.rawSchemaJson) {
							this.host.postMessage({
								type: 'crossClusterSchemaData',
								clusterName,
								clusterUrl: connection.clusterUrl,
								connectionId: connection.id,
								accountPartition: resolvedAccountPartition,
								database,
								boxId,
								requestToken,
								requestSource,
								deliverySource: result.fromCache ? 'client-cache-after-stale-cache' : 'fresh-after-stale-cache',
								cacheAgeMs: result.cacheAgeMs,
								rawSchemaJson: freshSchema.rawSchemaJson
							});
						}
						try {
							await this.saveCachedSchemaToDisk(cacheKey, {
								schema: freshSchema,
								timestamp,
								version: SCHEMA_CACHE_VERSION,
								clusterUrl: connection.clusterUrl,
								database,
								connectionId: connection.id,
								accountPartition: resolvedAccountPartition,
							}, result.cacheGeneration);
						} catch (cacheError) {
							this.host.output.warn(`[schema] failed to persist supplemental background schema clusterRef=${databaseListTraceRef(clusterName)} databaseRef=${databaseListTraceRef(database)} errorType=${cacheError instanceof Error ? cacheError.name : 'Error'}`);
						}
					} catch (refreshError) {
						if (!isConnectionCurrent()) return;
						trace('refresh.failed', { failureKind: supplementalFailureKind(refreshError, candidate => this.host.kustoClient.isAuthenticationError?.(candidate) === true) });
					}
				})();
				return;
			}

			const forceClientRefresh = !!cached && (!cachedIsLatestVersion || requestSource === 'autocomplete');
			const result = await this.host.kustoClient.getDatabaseSchema(connection, database, forceClientRefresh, {
				allowInteractive: requestSource === 'autocomplete',
				traceId,
				source: `supplemental-${requestSource}`,
			});
			if (!isConnectionCurrent()) return;
			const schema = requireWorkerReadySchema(result.schema, database);
			const resolvedAccountPartition = result.accountPartition;
			if (!resolvedAccountPartition) throw new Error('Supplemental schema authentication identity could not be resolved.');
			const resolvedCacheKey = schemaCacheKey(connection.clusterUrl, database, connection.id, resolvedAccountPartition);

			const timestamp = result.fromCache
				? Date.now() - (result.cacheAgeMs ?? 0)
				: Date.now();
			if (schema.rawSchemaJson) {
				trace('request.success', { deliverySource: result.fromCache ? 'client-cache' : 'fresh' });
				this.host.postMessage({
					type: 'crossClusterSchemaData',
					clusterName,
					clusterUrl: connection.clusterUrl,
					connectionId: connection.id,
					accountPartition: resolvedAccountPartition,
					database,
					boxId,
					requestToken,
					requestSource,
					deliverySource: result.fromCache ? 'client-cache' : 'fresh',
					cacheAgeMs: result.cacheAgeMs,
					rawSchemaJson: schema.rawSchemaJson
				});
				try {
					await this.saveCachedSchemaToDisk(resolvedCacheKey, {
						schema,
						timestamp,
						version: SCHEMA_CACHE_VERSION,
						clusterUrl: connection.clusterUrl,
						database,
						connectionId: connection.id,
						accountPartition: resolvedAccountPartition,
					}, result.cacheGeneration);
				} catch (cacheError) {
					this.host.output.warn(`[schema] failed to persist supplemental schema clusterRef=${databaseListTraceRef(clusterName)} databaseRef=${databaseListTraceRef(database)} errorType=${cacheError instanceof Error ? cacheError.name : 'Error'}`);
				}
			} else {
				trace('request.failed', { failureKind: 'invalid-schema' });
				this.host.postMessage({
					type: 'crossClusterSchemaError',
					clusterName,
					database,
					boxId,
					requestToken,
					requestSource,
					failureKind: 'invalid-schema',
					error: `Schema loaded but missing raw format required for autocomplete.`
				});
			}
		} catch (error) {
			if (!isConnectionCurrent()) return;
			const failureKind = supplementalFailureKind(error, candidate => this.host.kustoClient.isAuthenticationError?.(candidate) === true);
			trace('request.failed', { failureKind });
			const userMessage = this.host.formatQueryExecutionErrorForUser(error, connection, database);
			this.host.postMessage({
				type: 'crossClusterSchemaError',
				clusterName,
				database,
				boxId,
				requestToken,
				requestSource,
				failureKind,
				error: `Failed to load schema for ${clusterName}.${database}.\n${userMessage}`
			});
		}
	}

	// ── Tool orchestrator schema refresh ──

	async refreshSchemaForTools(
		clusterUrl: string,
		connectionId?: string,
		targets: readonly ({ boxId: string; database: string; requestToken?: string } & Partial<KustoEditorLifecycleIdentity>)[] = [],
	): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const connections = this.host.connectionManager.getConnections();
		const resolution = connectionId
			? resolveStrictKustoConnection(connections, { clusterUrl, connectionId })
			: resolveKustoConnection(connections, { clusterUrl });
		if (resolution.kind === 'ambiguous') return { schemas: [], error: 'Multiple saved connections match this cluster. Use a connection-specific schema request.' };
		if (resolution.kind === 'mismatch') return { schemas: [], error: 'The supplied connection does not match this cluster.' };
		if (resolution.kind === 'missing') return { schemas: [], error: 'No saved connection matches this cluster.' };
		return this.refreshSchemaForConnection(resolution.connection, targets);
	}

	private async refreshSchemaForConnection(connection: KustoConnection, targets: readonly ({ boxId: string; database: string; requestToken?: string } & Partial<KustoEditorLifecycleIdentity>)[] = []): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>; error?: string }> {
		const schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> = [];
		let connectionIdentity = '';
		try {
			connectionIdentity = getKustoConnectionIdentityKey(connection.clusterUrl, connection.authorityId);
		} catch {
			return { schemas, error: 'The saved Kusto connection has an invalid Tenant / Authority ID.' };
		}
		const isConnectionCurrent = () => this.isConnectionIdentityCurrent(connection.id, connectionIdentity);
		const pendingTargets = new Set(targets);
		const postTargetError = (target: (typeof targets)[number], error: string): void => {
			if (!pendingTargets.delete(target)) return;
			this.host.postMessage({
				type: 'schemaError', boxId: target.boxId, connectionId: connection.id,
				database: target.database, requestToken: target.requestToken,
				...(target.sectionInstanceId !== undefined && target.targetGeneration !== undefined
					? { sectionInstanceId: target.sectionInstanceId, targetGeneration: target.targetGeneration }
					: {}),
				silent: true, isBackgroundRefresh: true, refreshState: 'failed', error,
			});
		};
		const postAllTargetErrors = (error: string): void => {
			for (const target of Array.from(pendingTargets)) postTargetError(target, error);
		};
		try {
			const databases = await this.host.kustoClient.getDatabases(connection, true, {
				traceId: randomUUID(),
				source: 'query-editor-tool-schema-refresh',
			});
			if (!isConnectionCurrent()) return { schemas: [], error: 'The connection changed while schema refresh was running.' };
			if (databases.length === 0) {
				postAllTargetErrors('No databases found during schema refresh.');
				return { schemas: [], error: 'No databases found on this cluster, or insufficient permissions.' };
			}

			const errors: string[] = [];
			for (const db of databases) {
				try {
					const result = await this.host.kustoClient.getDatabaseSchema(connection, db, true);
					if (!isConnectionCurrent()) return { schemas: [], error: 'The connection changed while schema refresh was running.' };
					const schema = requireWorkerReadySchema(result.schema, db);
					const accountPartition = result.accountPartition;
					if (!accountPartition) throw new Error('Schema authentication identity could not be resolved.');

					const cacheKey = schemaCacheKey(connection.clusterUrl, db, connection.id, accountPartition);
					const timestamp = result.fromCache ? Date.now() - (result.cacheAgeMs ?? 0) : Date.now();
					await this.saveCachedSchemaToDisk(cacheKey, {
						schema,
						timestamp,
						version: SCHEMA_CACHE_VERSION,
						clusterUrl: connection.clusterUrl,
						database: db,
						connectionId: connection.id,
						accountPartition,
					}, result.cacheGeneration);
					if (!isConnectionCurrent()) return { schemas: [], error: 'The connection changed while schema refresh was running.' };

					for (const target of targets) {
						if (target.database.toLowerCase() !== db.toLowerCase()) continue;
						this.postSchemaData({
							boxId: target.boxId,
							connectionId: connection.id,
							database: db,
							clusterUrl: connection.clusterUrl,
							accountPartition,
							requestToken: target.requestToken,
							lifecycle: target.sectionInstanceId !== undefined && target.targetGeneration !== undefined
								? { sectionInstanceId: target.sectionInstanceId, targetGeneration: target.targetGeneration }
								: undefined,
							schema,
							meta: {
								fromCache: result.fromCache,
								cacheAgeMs: result.cacheAgeMs,
								forceRefresh: true,
								deliveryKind: result.fromCache ? 'memory-cache' : 'fresh',
								cacheState: 'fresh',
								isStale: false,
								refreshState: 'completed',
								workerUpdateNeeded: true,
							},
						});
						pendingTargets.delete(target);
					}

					const tables = schema.tables || [];
					const functions = (schema.functions || []).map(f => typeof f === 'string' ? f : f.name || '').filter(Boolean);
					schemas.push({
						clusterUrl: connection.clusterUrl,
						database: db,
						tables,
						functions
					});
				} catch (dbErr) {
					if (!isConnectionCurrent()) return { schemas: [], error: 'The connection changed while schema refresh was running.' };
					const dbError = dbErr instanceof Error ? dbErr.message : String(dbErr);
					for (const target of targets) {
						if (target.database.toLowerCase() === db.toLowerCase()) postTargetError(target, `Failed to refresh schema for ${db}.`);
					}
					errors.push(`${db}: ${dbError}`);
				}
			}
			postAllTargetErrors('The selected database was not found during schema refresh.');

			if (errors.length > 0 && schemas.length === 0) {
				return { schemas, error: `Failed to refresh schema for all databases: ${errors.join('; ')}` };
			}
			if (errors.length > 0) {
				return { schemas, error: `Some databases failed: ${errors.join('; ')}` };
			}
			return { schemas };
		} catch (err) {
			if (!isConnectionCurrent()) return { schemas: [], error: 'The connection changed while schema refresh was running.' };
			postAllTargetErrors('Schema refresh failed before the requested database could be loaded.');
			return { schemas, error: `Failed to refresh schema: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
}
