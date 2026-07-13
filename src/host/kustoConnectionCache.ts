import * as vscode from 'vscode';
import type { KustoConnection } from './connectionManager';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { normalizeKustoAuthorityId } from '../shared/kustoAuth';

const STORAGE_KEY = 'kusto.cachedDatabases.v2';
const LEGACY_STORAGE_KEY = 'kusto.cachedDatabases';
const CACHE_VERSION = 2 as const;
export const LEGACY_ACCOUNT_PARTITION = 'legacy-unpartitioned';

type DatabaseCacheEntry = {
	connectionId: string;
	accountPartition: string;
	databases: string[];
	timestamp: number;
};

type DatabaseCacheStore = {
	version: typeof CACHE_VERSION;
	entries: Record<string, DatabaseCacheEntry>;
};

export type KustoConnectionCacheGeneration = Readonly<{
	global: number;
	connection: number;
	partition: number;
}>;

type DatabaseCacheGenerations = {
	global: number;
	connections: Map<string, number>;
	partitions: Map<string, number>;
};

function entryKey(connectionId: string, accountPartition: string): string {
	return `${encodeURIComponent(connectionId)}::${accountPartition}`;
}

function normalizeDatabases(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	const databases: string[] = [];
	for (const value of values) {
		const database = String(value || '').trim();
		const key = database.toLowerCase();
		if (!database || seen.has(key)) continue;
		seen.add(key);
		databases.push(database);
	}
	return databases;
}

export class KustoConnectionCache {
	private static readonly writeChains = new WeakMap<object, Promise<unknown>>();
	private static readonly generations = new WeakMap<object, DatabaseCacheGenerations>();

	constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState'>) {}

	getDatabases(connectionId: string, accountPartition: string | undefined, allowLegacy: boolean): string[] {
		const store = this.readStore();
		if (accountPartition) {
			const exact = store.entries[entryKey(connectionId, accountPartition)];
			if (exact) return [...exact.databases];
		}
		if (!accountPartition && allowLegacy) {
			const legacy = store.entries[entryKey(connectionId, LEGACY_ACCOUNT_PARTITION)];
			if (legacy) return [...legacy.databases];
		}
		return [];
	}

	captureGeneration(connectionId: string = '', accountPartition: string = ''): KustoConnectionCacheGeneration {
		const generations = this.getGenerations();
		return {
			global: generations.global,
			connection: generations.connections.get(String(connectionId || '').trim()) ?? 0,
			partition: generations.partitions.get(String(accountPartition || '').trim()) ?? 0,
		};
	}

	setDatabases(connectionId: string, accountPartition: string, databasesRaw: unknown, expectedGeneration: KustoConnectionCacheGeneration = this.captureGeneration(connectionId, accountPartition)): Promise<boolean> {
		const id = String(connectionId || '').trim();
		const partition = String(accountPartition || '').trim();
		if (!id || !partition || partition === LEGACY_ACCOUNT_PARTITION) return Promise.resolve(false);
		const databases = normalizeDatabases(databasesRaw);
		return this.enqueue(async () => {
			if (!this.isGenerationCurrent(id, partition, expectedGeneration)) return false;
			const store = this.readStore();
			const key = entryKey(id, partition);
			delete store.entries[entryKey(id, LEGACY_ACCOUNT_PARTITION)];
			const existing = store.entries[key];
			if (databases.length === 0 && existing?.databases.length) return false;
			store.entries[key] = { connectionId: id, accountPartition: partition, databases, timestamp: Date.now() };
			await this.context.globalState.update(STORAGE_KEY, store);
			return true;
		});
	}

	clearConnection(connectionId: string): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id) return Promise.resolve();
		this.bumpConnectionGeneration(id);
		return this.enqueue(async () => {
			const store = this.readStore();
			let changed = false;
			for (const [key, entry] of Object.entries(store.entries)) {
				if (entry.connectionId === id) { delete store.entries[key]; changed = true; }
			}
			if (changed) await this.context.globalState.update(STORAGE_KEY, store);
		});
	}

	clearAccountPartition(accountPartition: string): Promise<void> {
		const partition = String(accountPartition || '').trim();
		if (!partition) return Promise.resolve();
		this.bumpPartitionGeneration(partition);
		return this.enqueue(async () => {
			const store = this.readStore();
			let changed = false;
			for (const [key, entry] of Object.entries(store.entries)) {
				if (entry.accountPartition === partition) { delete store.entries[key]; changed = true; }
			}
			if (changed) await this.context.globalState.update(STORAGE_KEY, store);
		});
	}

	clearAll(): Promise<void> {
		this.getGenerations().global++;
		return this.enqueue(async () => {
			await this.context.globalState.update(STORAGE_KEY, { version: CACHE_VERSION, entries: {} } satisfies DatabaseCacheStore);
			await this.context.globalState.update(LEGACY_STORAGE_KEY, undefined);
		});
	}

	getEntries(): DatabaseCacheEntry[] {
		return Object.values(this.readStore().entries).map(entry => ({ ...entry, databases: [...entry.databases] }));
	}

	async migrateLegacy(connections: readonly KustoConnection[]): Promise<void> {
		await this.enqueue(async () => {
			const legacy = this.context.globalState.get<Record<string, string[]> | undefined>(LEGACY_STORAGE_KEY);
			if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;
			const store = this.readStore();
			for (const [legacyKey, values] of Object.entries(legacy)) {
				const direct = connections.find(connection => connection.id === legacyKey);
				const candidates = direct ? [direct] : connections.filter(connection => kustoClusterKey(connection.clusterUrl) === kustoClusterKey(legacyKey));
				if (candidates.length !== 1) continue;
				const connection = candidates[0];
				try {
					if (normalizeKustoAuthorityId(connection.authorityId) !== undefined) continue;
				} catch {
					continue;
				}
				const key = entryKey(connection.id, LEGACY_ACCOUNT_PARTITION);
				if (!store.entries[key]) {
					store.entries[key] = {
						connectionId: connection.id,
						accountPartition: LEGACY_ACCOUNT_PARTITION,
						databases: normalizeDatabases(values),
						timestamp: 0,
					};
				}
			}
			await this.context.globalState.update(STORAGE_KEY, store);
			await this.context.globalState.update(LEGACY_STORAGE_KEY, undefined);
		});
	}

	private getGenerations(): DatabaseCacheGenerations {
		const owner = this.context.globalState as object;
		let generations = KustoConnectionCache.generations.get(owner);
		if (!generations) {
			generations = { global: 0, connections: new Map(), partitions: new Map() };
			KustoConnectionCache.generations.set(owner, generations);
		}
		return generations;
	}

	private isGenerationCurrent(connectionId: string, accountPartition: string, expected: KustoConnectionCacheGeneration): boolean {
		const current = this.captureGeneration(connectionId, accountPartition);
		return current.global === expected.global && current.connection === expected.connection && current.partition === expected.partition;
	}

	private bumpConnectionGeneration(connectionId: string): void {
		const generations = this.getGenerations();
		generations.connections.set(connectionId, (generations.connections.get(connectionId) ?? 0) + 1);
	}

	private bumpPartitionGeneration(accountPartition: string): void {
		const generations = this.getGenerations();
		generations.partitions.set(accountPartition, (generations.partitions.get(accountPartition) ?? 0) + 1);
	}

	private readStore(): DatabaseCacheStore {
		const raw = this.context.globalState.get<Partial<DatabaseCacheStore> | undefined>(STORAGE_KEY);
		if (!raw || raw.version !== CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') {
			return { version: CACHE_VERSION, entries: {} };
		}
		const entries: Record<string, DatabaseCacheEntry> = {};
		for (const [key, value] of Object.entries(raw.entries)) {
			if (!value || typeof value !== 'object') continue;
			const candidate = value as Partial<DatabaseCacheEntry>;
			const connectionId = String(candidate.connectionId || '').trim();
			const accountPartition = String(candidate.accountPartition || '').trim();
			if (!connectionId || !accountPartition) continue;
			entries[key] = {
				connectionId,
				accountPartition,
				databases: normalizeDatabases(candidate.databases),
				timestamp: Number.isFinite(candidate.timestamp) ? Number(candidate.timestamp) : 0,
			};
		}
		return { version: CACHE_VERSION, entries };
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const owner = this.context.globalState as object;
		const previous = KustoConnectionCache.writeChains.get(owner) ?? Promise.resolve();
		const next = previous.then(operation, operation);
		KustoConnectionCache.writeChains.set(owner, next.catch(() => undefined));
		return next;
	}
}