import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { KustoConnection } from './connectionManager';
import { exportKustoClusterEndpoint } from '../shared/kustoClusterUrls';
import { KUSTO_AUTH_PROVIDER_ID, normalizeKustoAuthorityId } from '../shared/kustoAuth';
import { getWorkbenchLogger } from './workbenchLogger';

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
	firstEstablishment?: boolean;
};

type StoredPreferences = Record<string, KustoAccountPreference>;
type ProviderSessionChange = Readonly<{
	added?: readonly vscode.AuthenticationSession[];
	removed?: readonly vscode.AuthenticationSession[];
	changed?: readonly vscode.AuthenticationSession[];
}>;

type ObservedProviderSession = Readonly<{
	sessionId: string;
	sessionFingerprint: string;
	account: vscode.AuthenticationSessionAccountInformation;
	scopes: readonly string[];
}>;

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
	private providerAccountIds = new Set<string>();
	private providerAccountsInitialized = false;
	private providerAccountRefresh: Promise<void>;
	private readonly observedProviderSessions = new Map<string, ObservedProviderSession>();
	private readonly providerSessionGenerations = new Map<string, number>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.providerAccountRefresh = this.refreshProviderAccounts(false);
		this.authSubscription = vscode.authentication.onDidChangeSessions?.(event => {
			if (event.provider.id === KUSTO_AUTH_PROVIDER_ID) {
				const overlappedInitialBaseline = !this.providerAccountsInitialized;
				const mappedAccountIdsAtEvent = this.mappedAccountIds();
				const observedSessionsAtEvent = new Map(this.observedProviderSessions);
				const sessionGenerationsAtEvent = new Map(this.providerSessionGenerations);
				const refresh = () => this.refreshProviderAccounts(
					true, event as unknown as ProviderSessionChange,
					overlappedInitialBaseline, mappedAccountIdsAtEvent,
					observedSessionsAtEvent, sessionGenerationsAtEvent,
				);
				this.providerAccountRefresh = this.providerAccountRefresh.then(refresh, refresh);
			}
		});
		if (this.authSubscription && Array.isArray(context.subscriptions)) {
			context.subscriptions.push(this.authSubscription);
		}
	}

	private async refreshProviderAccounts(
		emitRemoval: boolean,
		event?: ProviderSessionChange,
		overlappedInitialBaseline = false,
		mappedAccountIdsAtEvent: ReadonlySet<string> = new Set(),
		observedSessionsAtEvent: ReadonlyMap<string, ObservedProviderSession> = new Map(),
		sessionGenerationsAtEvent: ReadonlyMap<string, number> = new Map(),
	): Promise<void> {
		let accounts: readonly vscode.AuthenticationSessionAccountInformation[];
		try {
			accounts = await vscode.authentication.getAccounts(KUSTO_AUTH_PROVIDER_ID);
		} catch (error) {
			getWorkbenchLogger().warn(`[kusto-auth] Failed to refresh provider accounts: ${error instanceof Error ? error.message : String(error)}`);
			if (emitRemoval) this.invalidateUncertainProviderChange(event);
			return;
		}
		const current = new Set(accounts.map(account => String(account?.id || '').trim()).filter(Boolean));
		const hadBaseline = this.providerAccountsInitialized;
		const removed = new Set([...this.providerAccountIds].filter(accountId => !current.has(accountId)));
		const added = new Set([...current].filter(accountId => !this.providerAccountIds.has(accountId)));
		const observedSessionChanges = emitRemoval
			? await this.refreshObservedProviderSessions(current, observedSessionsAtEvent)
			: new Set<string>();
		const explicitlyChanged = new Set((event?.changed || [])
			.map(session => String(session?.account?.id || '').trim())
			.filter(Boolean));
		const explicitlyRemoved = new Set((event?.removed || [])
			.map(session => String(session?.account?.id || '').trim())
			.filter(Boolean));
		const hasExplicitSessionDetails = (event?.added?.length || 0) > 0
			|| (event?.removed?.length || 0) > 0
			|| (event?.changed?.length || 0) > 0;
		const changed = !emitRemoval
			? new Set<string>()
			: new Set([
				...observedSessionChanges,
				...explicitlyChanged,
				...(!hasExplicitSessionDetails && observedSessionChanges.size === 0 && removed.size === 0 && added.size === 0
					? [...mappedAccountIdsAtEvent].filter(accountId => current.has(accountId)
						&& ![...observedSessionsAtEvent.values()].some(observed => observed.account.id === accountId))
					: []),
			]);
		this.providerAccountIds = current;
		this.providerAccountsInitialized = true;
		const hasExplicitRemovalOrChange = (event?.removed?.length || 0) > 0 || (event?.changed?.length || 0) > 0;
		if (emitRemoval && overlappedInitialBaseline && !hasExplicitRemovalOrChange
			&& removed.size === 0 && added.size === 0) {
			const connectionIds = this.connectionIdsForAccounts(mappedAccountIdsAtEvent);
			if (connectionIds.length > 0) this.changeEmitter.fire({ connectionIds, reason: 'sessions-changed' });
			return;
		}
		if (emitRemoval && !hadBaseline) {
			this.invalidateUncertainProviderChange(event);
			return;
		}
		if (!emitRemoval || (removed.size === 0 && explicitlyRemoved.size === 0 && changed.size === 0)) return;
		const invalidatedAccountIds = new Set([...removed, ...explicitlyRemoved, ...changed].filter(accountId => {
			const generationAtEvent = sessionGenerationsAtEvent.get(accountId) ?? 0;
			return this.getProviderSessionGeneration(accountId) <= generationAtEvent;
		}));
		for (const accountId of invalidatedAccountIds) this.advanceProviderSessionGeneration(accountId);
		const connectionIds = this.connectionIdsForAccounts(invalidatedAccountIds);
		if (connectionIds.length > 0) this.changeEmitter.fire({ connectionIds, reason: 'sessions-changed' });
	}

	private async refreshObservedProviderSessions(
		currentAccountIds: ReadonlySet<string>,
		observedSessionsAtEvent: ReadonlyMap<string, ObservedProviderSession>,
	): Promise<Set<string>> {
		const changed = new Set<string>();
		for (const [observationKey, observed] of observedSessionsAtEvent) {
			const accountId = observed.account.id;
			if (!currentAccountIds.has(accountId)) continue;
			try {
				const session = await vscode.authentication.getSession(
					KUSTO_AUTH_PROVIDER_ID,
					[...observed.scopes],
					{ silent: true, account: observed.account },
				);
				const sessionFingerprint = session
					? hashIdentity(`${session.id}\u0000${String(session.accessToken || '')}`)
					: '';
				if (!session || session.account.id !== accountId || sessionFingerprint !== observed.sessionFingerprint) {
					changed.add(accountId);
					if (session?.account.id === accountId) {
						this.observedProviderSessions.set(observationKey, Object.freeze({
							sessionId: session.id,
							sessionFingerprint,
							account: Object.freeze({ id: session.account.id, label: session.account.label }),
							scopes: Object.freeze([...observed.scopes]),
						}));
					}
				}
			} catch {
				changed.add(accountId);
			}
		}
		return changed;
	}

	private advanceProviderSessionGeneration(accountIdRaw: string): number {
		const accountId = String(accountIdRaw || '').trim();
		if (!accountId) return 0;
		const next = (this.providerSessionGenerations.get(accountId) ?? 0) + 1;
		this.providerSessionGenerations.set(accountId, next);
		return next;
	}

	private providerSessionObservationKey(accountId: string, scopes: readonly string[]): string {
		return `${accountId}\u0000${[...scopes].map(scope => String(scope || '').trim()).filter(Boolean).sort().join('\u0001')}`;
	}

	observeProviderSession(session: vscode.AuthenticationSession, scopes: readonly string[]): void {
		const accountId = String(session?.account?.id || '').trim();
		const sessionId = String(session?.id || '').trim();
		if (!accountId || !sessionId) return;
		const observationKey = this.providerSessionObservationKey(accountId, scopes);
		const previous = this.observedProviderSessions.get(observationKey);
		const sessionFingerprint = hashIdentity(`${sessionId}\u0000${String(session.accessToken || '')}`);
		this.observedProviderSessions.set(observationKey, Object.freeze({
			sessionId,
			sessionFingerprint,
			account: Object.freeze({ id: accountId, label: session.account.label }),
			scopes: Object.freeze([...scopes]),
		}));
		if (!previous) {
			this.providerSessionGenerations.set(accountId, this.providerSessionGenerations.get(accountId) ?? 0);
			return;
		}
		if (previous.sessionFingerprint === sessionFingerprint) return;
		this.advanceProviderSessionGeneration(accountId);
		const connectionIds = this.connectionIdsForAccounts(new Set([accountId]));
		if (connectionIds.length > 0) this.changeEmitter.fire({ connectionIds, reason: 'sessions-changed' });
	}

	getProviderSessionGeneration(accountIdRaw: string): number {
		return this.providerSessionGenerations.get(String(accountIdRaw || '').trim()) ?? 0;
	}

	getConnectionSessionGeneration(connectionId: string): number {
		return this.getProviderSessionGeneration(this.getPreferredAccountId(connectionId) || '');
	}

	async waitForProviderAccountRefresh(): Promise<void> {
		await this.providerAccountRefresh;
	}

	private invalidateUncertainProviderChange(event?: ProviderSessionChange): void {
		const removedOrChanged = [...(event?.removed || []), ...(event?.changed || [])];
		const addedOnly = (event?.added?.length || 0) > 0 && removedOrChanged.length === 0;
		if (addedOnly) return;
		const affectedAccountIds = new Set(removedOrChanged
			.map(session => String(session?.account?.id || '').trim())
			.filter(Boolean));
		const connectionIds = affectedAccountIds.size > 0
			? this.connectionIdsForAccounts(affectedAccountIds)
			: this.connectionIdsForAccounts(this.mappedAccountIds());
		if (connectionIds.length > 0) this.changeEmitter.fire({ connectionIds, reason: 'sessions-changed' });
	}

	private mappedAccountIds(): Set<string> {
		const accountIds = new Set<string>();
		for (const rawPreference of Object.values(this.readPreferences())) {
			const preference = parsePreference(rawPreference);
			const accountId = preference?.mode === 'explicit'
				? preference.accountId
				: preference?.lastSuccessfulAccountId ?? preference?.legacyAccountId;
			if (accountId) accountIds.add(accountId);
		}
		return accountIds;
	}

	private connectionIdsForAccounts(accountIds: ReadonlySet<string>): string[] {
		if (accountIds.size === 0) return [];
		const affected: string[] = [];
		for (const [connectionId, rawPreference] of Object.entries(this.readPreferences())) {
			const preference = parsePreference(rawPreference);
			if (!preference) continue;
			const accountId = preference.mode === 'explicit'
				? preference.accountId
				: preference.lastSuccessfulAccountId ?? preference.legacyAccountId;
			if (accountId && accountIds.has(accountId)) affected.push(connectionId);
		}
		return [...new Set(affected)].sort();
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
			let firstEstablishment = false;
			if (current.mode === 'automatic') {
				const previousAccountId = current.lastSuccessfulAccountId ?? current.legacyAccountId;
				firstEstablishment = !previousAccountId;
				preferenceChanged = current.lastSuccessfulAccountId !== accountId || !!current.legacyAccountId;
				if (preferenceChanged) {
					preferences[id] = { mode: 'automatic', lastSuccessfulAccountId: accountId };
					await this.context.globalState.update(STORAGE_KEYS.preferences, preferences);
				}
			}
			await this.upsertKnownAccount(account);
			if (preferenceChanged) this.changeEmitter.fire({
				connectionIds: [id], reason: 'success', accountId, accountPartition, firstEstablishment,
			});
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