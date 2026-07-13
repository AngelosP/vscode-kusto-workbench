import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { KustoConnection } from './connectionManager';
import { exportKustoClusterEndpoint } from '../shared/kustoClusterUrls';
import { KUSTO_AUTH_PROVIDER_ID, normalizeKustoAuthorityId } from '../shared/kustoAuth';

const STORAGE_KEYS = {
	preferences: 'kusto.auth.connectionPreferences.v1',
	knownAccounts: 'kusto.auth.knownAccounts',
	legacyClusterAccountMap: 'kusto.auth.clusterAccountMap',
	legacyMigrationComplete: 'kusto.auth.connectionPreferences.legacyMigration.v1',
} as const;

const SECRET_PREFIX = 'kusto.auth.tokenOverride.v1.';
const LEGACY_SECRET_PREFIX = 'kusto.auth.tokenOverride.';

export type KustoKnownAccount = {
	id: string;
	label: string;
	lastUsedAt: number;
};

export type KustoAccountPreference =
	| { mode: 'automatic'; lastSuccessfulAccountId?: string; legacyAccountId?: string }
	| { mode: 'explicit'; accountId: string };

export type KustoAuthPreferenceChange = {
	connectionIds: string[];
	reason: 'selection' | 'success' | 'account-forgotten' | 'migration' | 'sessions-changed' | 'override';
	accountId?: string;
	accountPartition?: string;
};

type StoredPreferences = Record<string, KustoAccountPreference>;

function hashIdentity(material: string): string {
	return createHash('sha256').update(material, 'utf8').digest('hex');
}

function parsePreference(value: unknown): KustoAccountPreference | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const candidate = value as Partial<KustoAccountPreference> & { mode?: unknown };
	if (candidate.mode === 'explicit') {
		const accountId = String((candidate as { accountId?: unknown }).accountId ?? '').trim();
		return accountId ? { mode: 'explicit', accountId } : undefined;
	}
	if (candidate.mode === 'automatic') {
		const lastSuccessfulAccountId = String((candidate as { lastSuccessfulAccountId?: unknown }).lastSuccessfulAccountId ?? '').trim() || undefined;
		const legacyAccountId = String((candidate as { legacyAccountId?: unknown }).legacyAccountId ?? '').trim() || undefined;
		return { mode: 'automatic', ...(lastSuccessfulAccountId ? { lastSuccessfulAccountId } : {}), ...(legacyAccountId ? { legacyAccountId } : {}) };
	}
	return undefined;
}

export class KustoAuthPreferenceService implements vscode.Disposable {
	private static readonly instances = new WeakMap<object, KustoAuthPreferenceService>();

	static getInstance(context: vscode.ExtensionContext): KustoAuthPreferenceService {
		const existing = this.instances.get(context as object);
		if (existing) return existing;
		const service = new KustoAuthPreferenceService(context);
		this.instances.set(context as object, service);
		return service;
	}

	private readonly changeEmitter = new vscode.EventEmitter<KustoAuthPreferenceChange>();
	readonly onDidChange = this.changeEmitter.event;
	private writeChain: Promise<unknown> = Promise.resolve();
	private readonly authSubscription: vscode.Disposable | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.authSubscription = vscode.authentication.onDidChangeSessions?.(event => {
			if (event.provider.id === KUSTO_AUTH_PROVIDER_ID) {
				this.changeEmitter.fire({ connectionIds: [], reason: 'sessions-changed' });
			}
		});
		if (this.authSubscription && Array.isArray(context.subscriptions)) {
			context.subscriptions.push(this.authSubscription);
		}
	}

	dispose(): void {
		this.authSubscription?.dispose();
		this.changeEmitter.dispose();
	}

	getPreference(connectionId: string): KustoAccountPreference {
		const id = String(connectionId || '').trim();
		const parsed = parsePreference(this.readPreferences()[id]);
		return parsed ?? { mode: 'automatic' };
	}

	getPreferredAccountId(connectionId: string): string | undefined {
		const preference = this.getPreference(connectionId);
		return preference.mode === 'explicit'
			? preference.accountId
			: preference.lastSuccessfulAccountId ?? preference.legacyAccountId;
	}

	setAutomatic(connectionId: string): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id) return Promise.resolve();
		return this.enqueue(async () => {
			const preferences = this.readPreferences();
			const current = parsePreference(preferences[id]);
			preferences[id] = current?.mode === 'automatic'
				? current
				: { mode: 'automatic' };
			await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
			this.changeEmitter.fire({ connectionIds: [id], reason: 'selection' });
		});
	}

	setExplicitAccount(connectionId: string, account: vscode.AuthenticationSessionAccountInformation): Promise<void> {
		const id = String(connectionId || '').trim();
		const accountId = String(account?.id || '').trim();
		if (!id || !accountId) return Promise.resolve();
		return this.enqueue(async () => {
			const preferences = this.readPreferences();
			preferences[id] = { mode: 'explicit', accountId };
			await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
			await this.upsertKnownAccount(account);
			this.changeEmitter.fire({ connectionIds: [id], reason: 'selection', accountId });
		});
	}

	recordSuccessfulAccount(connectionId: string, account: vscode.AuthenticationSessionAccountInformation, accountPartition?: string): Promise<boolean> {
		const id = String(connectionId || '').trim();
		const accountId = String(account?.id || '').trim();
		if (!id || !accountId) return Promise.resolve(false);
		return this.enqueue(async () => {
			const preferences = this.readPreferences();
			const current = parsePreference(preferences[id]) ?? { mode: 'automatic' as const };
			if (current.mode === 'explicit' && current.accountId !== accountId) return false;
			let preferenceChanged = false;
			if (current.mode === 'automatic') {
				preferenceChanged = current.lastSuccessfulAccountId !== accountId || !!current.legacyAccountId;
				if (preferenceChanged) {
					preferences[id] = { mode: 'automatic', lastSuccessfulAccountId: accountId };
					await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
				}
			}
			await this.upsertKnownAccount(account);
			if (preferenceChanged) this.changeEmitter.fire({ connectionIds: [id], reason: 'success', accountId, accountPartition });
			return preferenceChanged;
		});
	}

	removeConnection(connectionId: string): Promise<void> {
		const id = String(connectionId || '').trim();
		if (!id) return Promise.resolve();
		return this.enqueue(async () => {
			const preferences = this.readPreferences();
			if (!Object.prototype.hasOwnProperty.call(preferences, id)) return;
			delete preferences[id];
			await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
			this.changeEmitter.fire({ connectionIds: [id], reason: 'selection' });
		});
	}

	forgetAccount(accountIdRaw: string): Promise<void> {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return Promise.resolve();
		return this.enqueue(async () => {
			const preferences = this.readPreferences();
			const affected: string[] = [];
			for (const [connectionId, rawPreference] of Object.entries(preferences)) {
				const preference = parsePreference(rawPreference);
				if (!preference) continue;
				if (preference.mode === 'explicit' && preference.accountId === accountId) {
					delete preferences[connectionId];
					affected.push(connectionId);
				} else if (preference.mode === 'automatic'
					&& (preference.lastSuccessfulAccountId === accountId || preference.legacyAccountId === accountId)) {
					preferences[connectionId] = { mode: 'automatic' };
					affected.push(connectionId);
				}
			}
			await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
			const knownAccounts = this.readKnownAccounts().filter(account => account.id !== accountId);
			await this.context.globalState.update(STORAGE_KEYS.knownAccounts, knownAccounts);
			for (const key of await this.context.secrets.keys()) {
				if (key.startsWith(SECRET_PREFIX) && key.endsWith(`.${hashIdentity(accountId)}`)) {
					await this.context.secrets.delete(key);
				}
			}
			await this.context.secrets.delete(`${LEGACY_SECRET_PREFIX}${accountId}`);
			this.changeEmitter.fire({ connectionIds: affected, reason: 'account-forgotten', accountId });
		});
	}

	async getAccounts(): Promise<KustoKnownAccount[]> {
		const accounts = new Map<string, KustoKnownAccount>();
		for (const account of this.readKnownAccounts()) accounts.set(account.id, account);
		try {
			for (const account of await vscode.authentication.getAccounts(KUSTO_AUTH_PROVIDER_ID)) {
				const existing = accounts.get(account.id);
				accounts.set(account.id, { id: account.id, label: account.label || existing?.label || account.id, lastUsedAt: existing?.lastUsedAt ?? 0 });
			}
		} catch {
			// The historical account list remains useful if provider enumeration fails.
		}
		return [...accounts.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt || left.label.localeCompare(right.label));
	}

	async migrateLegacyMappings(connections: readonly KustoConnection[]): Promise<void> {
		if (this.context.globalState.get<boolean>(STORAGE_KEYS.legacyMigrationComplete)) return;
		await this.enqueue(async () => {
			if (this.context.globalState.get<boolean>(STORAGE_KEYS.legacyMigrationComplete)) return;
			const legacy = this.context.globalState.get<Record<string, string> | undefined>(STORAGE_KEYS.legacyClusterAccountMap) ?? {};
			const preferences = this.readPreferences();
			const affected: string[] = [];
			const connectionsByEndpoint = new Map<string, KustoConnection[]>();
			for (const connection of connections) {
				const endpoint = exportKustoClusterEndpoint(connection.clusterUrl);
				connectionsByEndpoint.set(endpoint, [...(connectionsByEndpoint.get(endpoint) ?? []), connection]);
			}
			for (const [endpoint, matches] of connectionsByEndpoint) {
				if (matches.length !== 1) continue;
				const connection = matches[0];
				if (parsePreference(preferences[connection.id])) continue;
				const accountId = String(legacy[endpoint] ?? '').trim();
				if (!accountId) continue;
				preferences[connection.id] = { mode: 'automatic', legacyAccountId: accountId };
				affected.push(connection.id);
			}
			await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
			await this.context.globalState.update(STORAGE_KEYS.legacyMigrationComplete, true);
			if (affected.length) this.changeEmitter.fire({ connectionIds: affected, reason: 'migration' });
		});
	}

	getAccountPartition(authorityId: unknown, accountIdRaw: string): string {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return '';
		return hashIdentity(`kusto-auth-partition-v1|${normalizeKustoAuthorityId(authorityId) ?? 'organizations'}|${accountId}`);
	}

	async getTokenOverride(authorityId: unknown, accountIdRaw: string): Promise<string | undefined> {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return undefined;
		const key = this.overrideKey(authorityId, accountId);
		const token = String(await this.context.secrets.get(key) ?? '').trim();
		if (token) return token;
		if (normalizeKustoAuthorityId(authorityId) === undefined) {
			return String(await this.context.secrets.get(`${LEGACY_SECRET_PREFIX}${accountId}`) ?? '').trim() || undefined;
		}
		return undefined;
	}

	async setTokenOverride(authorityId: unknown, accountIdRaw: string, tokenRaw: string, connectionIds: readonly string[] = []): Promise<void> {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return;
		const token = String(tokenRaw || '').trim();
		const key = this.overrideKey(authorityId, accountId);
		if (normalizeKustoAuthorityId(authorityId) === undefined) await this.context.secrets.delete(`${LEGACY_SECRET_PREFIX}${accountId}`);
		if (token) await this.context.secrets.store(key, token);
		else await this.context.secrets.delete(key);
		this.changeEmitter.fire({ connectionIds: [...connectionIds], reason: 'override', accountId, accountPartition: this.getAccountPartition(authorityId, accountId) });
	}

	async clearTokenOverride(authorityId: unknown, accountIdRaw: string, connectionIds: readonly string[] = []): Promise<void> {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return;
		await this.context.secrets.delete(this.overrideKey(authorityId, accountId));
		if (normalizeKustoAuthorityId(authorityId) === undefined) await this.context.secrets.delete(`${LEGACY_SECRET_PREFIX}${accountId}`);
		this.changeEmitter.fire({ connectionIds: [...connectionIds], reason: 'override', accountId, accountPartition: this.getAccountPartition(authorityId, accountId) });
	}

	private overrideKey(authorityId: unknown, accountId: string): string {
		const authorityHash = hashIdentity(normalizeKustoAuthorityId(authorityId) ?? 'organizations');
		return `${SECRET_PREFIX}${authorityHash}.${hashIdentity(accountId)}`;
	}

	private readPreferences(): StoredPreferences {
		const raw = this.context.globalState.get<Record<string, unknown> | undefined>(STORAGE_KEYS.preferences);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const preferences: StoredPreferences = {};
		for (const [connectionId, value] of Object.entries(raw)) {
			const parsed = parsePreference(value);
			if (connectionId.trim() && parsed) preferences[connectionId] = parsed;
		}
		return preferences;
	}

	private readKnownAccounts(): KustoKnownAccount[] {
		const raw = this.context.globalState.get<unknown>(STORAGE_KEYS.knownAccounts);
		if (!Array.isArray(raw)) return [];
		return raw.flatMap(value => {
			if (!value || typeof value !== 'object') return [];
			const account = value as Partial<KustoKnownAccount>;
			const id = String(account.id ?? '').trim();
			const label = String(account.label ?? '').trim();
			return id && label ? [{ id, label, lastUsedAt: Number.isFinite(account.lastUsedAt) ? Number(account.lastUsedAt) : 0 }] : [];
		});
	}

	private async upsertKnownAccount(account: vscode.AuthenticationSessionAccountInformation): Promise<void> {
		const existing = this.readKnownAccounts().filter(candidate => candidate.id !== account.id);
		existing.unshift({ id: account.id, label: account.label || account.id, lastUsedAt: Date.now() });
		await this.context.globalState.update(STORAGE_KEYS.knownAccounts, existing.slice(0, 20));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.writeChain.then(operation, operation);
		this.writeChain = next.catch(() => undefined);
		return next;
	}
}