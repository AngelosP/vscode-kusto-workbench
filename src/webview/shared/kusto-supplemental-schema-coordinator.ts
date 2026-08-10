export type KustoSupplementalRequestSource = 'background' | 'autocomplete';

export type KustoSupplementalSchemaStatus =
	| 'scheduled'
	| 'fetching'
	| 'fetched'
	| 'waiting-primary'
	| 'applying'
	| 'loaded'
	| 'failed';

export type KustoSupplementalFailureKind =
	| 'missing-connection'
	| 'auth-required'
	| 'not-found'
	| 'fetch-timeout'
	| 'fetch-failed'
	| 'invalid-schema'
	| 'apply-timeout'
	| 'apply-failed';

export type KustoSupplementalReference = Readonly<{
	schemaKey: string;
	clusterName: string;
	database: string;
}>;

export type KustoSupplementalSchemaState = Readonly<{
	boxId: string;
	modelUri: string;
	modelVersion: number;
	primarySchemaKey?: string;
	schemaKey: string;
	clusterName: string;
	database: string;
	referenceGeneration: number;
	status: KustoSupplementalSchemaStatus;
	requestSource: KustoSupplementalRequestSource;
	requestToken?: string;
	fetchedAvailable: boolean;
	deadlineAt?: number;
	failureKind?: KustoSupplementalFailureKind;
	updatedAt: number;
}>;

export type KustoSupplementalCoordinatorTrace = Readonly<{
	event: 'reference-sync' | 'state-transition' | 'stale-transition' | 'model-disposed' | 'deadline-expired';
	modelId: string;
	schemaId?: string;
	status?: KustoSupplementalSchemaStatus;
	previousStatus?: KustoSupplementalSchemaStatus;
	requestSource?: KustoSupplementalRequestSource;
	failureKind?: KustoSupplementalFailureKind;
	addedCount?: number;
	removedCount?: number;
	retainedCount?: number;
}>;

type MutableState = {
	boxId: string;
	modelUri: string;
	modelVersion: number;
	primarySchemaKey?: string;
	schemaKey: string;
	clusterName: string;
	database: string;
	referenceGeneration: number;
	status: KustoSupplementalSchemaStatus;
	requestSource: KustoSupplementalRequestSource;
	requestToken?: string;
	fetchedAvailable: boolean;
	deadlineAt?: number;
	failureKind?: KustoSupplementalFailureKind;
	updatedAt: number;
};

type ModelState = {
	boxId: string;
	modelUri: string;
	modelVersion: number;
	primarySchemaKey?: string;
	primaryReady: boolean;
	references: Map<string, MutableState>;
};

export type KustoSupplementalStateIdentity = Readonly<{
	modelUri: string;
	schemaKey: string;
	referenceGeneration: number;
}>;

const SUPPRESSED_STATUSES = new Set<KustoSupplementalSchemaStatus>([
	'scheduled',
	'fetching',
	'fetched',
	'waiting-primary',
	'applying',
	'loaded',
]);

export function kustoSupplementalTraceId(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function freezeState(state: MutableState): KustoSupplementalSchemaState {
	return Object.freeze({ ...state });
}

function normalizeReference(reference: KustoSupplementalReference): KustoSupplementalReference | null {
	const schemaKey = String(reference?.schemaKey || '').trim();
	const clusterName = String(reference?.clusterName || '').trim();
	const database = String(reference?.database || '').trim();
	if (!schemaKey || !clusterName || !database) return null;
	return Object.freeze({ schemaKey, clusterName, database });
}

export class KustoSupplementalSchemaCoordinator {
	private readonly models = new Map<string, ModelState>();
	private nextReferenceGeneration = 0;

	constructor(private readonly trace?: (event: KustoSupplementalCoordinatorTrace) => void) {}

	syncReferences(args: {
		boxId: string;
		modelUri: string;
		modelVersion: number;
		primarySchemaKey?: string;
		references: readonly KustoSupplementalReference[];
		now?: number;
	}): { added: KustoSupplementalSchemaState[]; retained: KustoSupplementalSchemaState[]; removed: KustoSupplementalSchemaState[] } {
		const boxId = String(args.boxId || '').trim();
		const modelUri = String(args.modelUri || '').trim();
		if (!boxId || !modelUri) return { added: [], retained: [], removed: [] };
		const now = args.now ?? Date.now();
		let model = this.models.get(modelUri);
		const primarySchemaKey = String(args.primarySchemaKey || '').trim() || undefined;
		if (!model) {
			model = {
				boxId,
				modelUri,
				modelVersion: args.modelVersion,
				primarySchemaKey,
				primaryReady: false,
				references: new Map(),
			};
			this.models.set(modelUri, model);
		}
		const primaryChanged = model.primarySchemaKey !== primarySchemaKey;
		model.boxId = boxId;
		model.modelVersion = args.modelVersion;
		model.primarySchemaKey = primarySchemaKey;
		if (primaryChanged) {
			model.primaryReady = false;
			for (const state of model.references.values()) {
				if (state.fetchedAvailable) {
					state.deadlineAt = undefined;
					this.transitionMutable(state, 'waiting-primary', now);
				}
			}
		}

		const nextReferences = new Map<string, KustoSupplementalReference>();
		for (const candidate of args.references || []) {
			const reference = normalizeReference(candidate);
			if (reference && !nextReferences.has(reference.schemaKey)) nextReferences.set(reference.schemaKey, reference);
		}

		const removed: KustoSupplementalSchemaState[] = [];
		for (const [schemaKey, state] of model.references) {
			if (!nextReferences.has(schemaKey)) {
				removed.push(freezeState(state));
				model.references.delete(schemaKey);
			}
		}

		const added: KustoSupplementalSchemaState[] = [];
		const retained: KustoSupplementalSchemaState[] = [];
		for (const reference of nextReferences.values()) {
			const existing = model.references.get(reference.schemaKey);
			if (existing) {
				existing.boxId = boxId;
				existing.modelVersion = args.modelVersion;
				existing.primarySchemaKey = primarySchemaKey;
				existing.clusterName = reference.clusterName;
				existing.database = reference.database;
				retained.push(freezeState(existing));
				continue;
			}
			const state: MutableState = {
				boxId,
				modelUri,
				modelVersion: args.modelVersion,
				primarySchemaKey,
				schemaKey: reference.schemaKey,
				clusterName: reference.clusterName,
				database: reference.database,
				referenceGeneration: ++this.nextReferenceGeneration,
				status: 'scheduled',
				requestSource: 'background',
				fetchedAvailable: false,
				updatedAt: now,
			};
			model.references.set(reference.schemaKey, state);
			added.push(freezeState(state));
		}

		if (added.length > 0 || removed.length > 0) {
			this.emit({
				event: 'reference-sync',
				modelId: kustoSupplementalTraceId(modelUri),
				addedCount: added.length,
				removedCount: removed.length,
				retainedCount: retained.length,
			});
		}
		return { added, retained, removed };
	}

	setPrimaryReady(modelUri: string, ready: boolean, now: number = Date.now()): KustoSupplementalSchemaState[] {
		const model = this.models.get(String(modelUri || '').trim());
		if (!model) return [];
		model.primaryReady = ready;
		const changed: KustoSupplementalSchemaState[] = [];
		for (const state of model.references.values()) {
			if (!ready && state.fetchedAvailable && state.status !== 'failed') {
				state.deadlineAt = undefined;
				this.transitionMutable(state, 'waiting-primary', now);
				changed.push(freezeState(state));
			} else if (ready && state.fetchedAvailable && state.status === 'waiting-primary') {
				this.transitionMutable(state, 'fetched', now);
				changed.push(freezeState(state));
			}
		}
		return changed;
	}

	markFetching(identity: KustoSupplementalStateIdentity, args: {
		requestToken: string;
		requestSource: KustoSupplementalRequestSource;
		deadlineAt: number;
		preserveFetchedAvailable?: boolean;
		now?: number;
	}): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state) return this.stale(identity);
		if (state.requestSource === 'autocomplete' && args.requestSource === 'background') {
			state.updatedAt = args.now ?? Date.now();
			return freezeState(state);
		}
		state.requestToken = String(args.requestToken || '').trim() || undefined;
		state.requestSource = args.requestSource;
		state.deadlineAt = args.deadlineAt;
		state.failureKind = undefined;
		if (!args.preserveFetchedAvailable) state.fetchedAvailable = false;
		this.transitionMutable(state, 'fetching', args.now ?? Date.now());
		return freezeState(state);
	}

	bindSchemaRequest(schemaKey: string, args: {
		requestToken: string;
		requestSource: KustoSupplementalRequestSource;
		deadlineAt: number;
		preserveFetchedAvailable?: boolean;
		includeFetching?: boolean;
		now?: number;
	}): KustoSupplementalSchemaState[] {
		const rebound: KustoSupplementalSchemaState[] = [];
		for (const state of this.getStatesForSchemaKey(schemaKey)) {
			if (state.status !== 'scheduled' && !(args.includeFetching && state.status === 'fetching')) continue;
			const next = this.markFetching(supplementalStateIdentity(state), args);
			if (next) rebound.push(next);
		}
		return rebound;
	}

	escalateToAutocomplete(identity: KustoSupplementalStateIdentity, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state) return this.stale(identity);
		const wasBackgroundFetch = state.status === 'fetching' && state.requestSource === 'background';
		state.requestSource = 'autocomplete';
		state.failureKind = undefined;
		if (state.status === 'failed' || wasBackgroundFetch) {
			state.requestToken = undefined;
			state.deadlineAt = undefined;
			state.fetchedAvailable = false;
			this.transitionMutable(state, 'scheduled', now);
		} else {
			state.updatedAt = now;
		}
		return freezeState(state);
	}

	refreshWithAutocomplete(identity: KustoSupplementalStateIdentity, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state || !state.fetchedAvailable) return this.stale(identity);
		state.requestSource = 'autocomplete';
		state.requestToken = undefined;
		state.deadlineAt = undefined;
		state.failureKind = undefined;
		this.transitionMutable(state, 'scheduled', now);
		return freezeState(state);
	}

	markSchemaRefreshed(schemaKey: string, requestToken?: string, now: number = Date.now()): KustoSupplementalSchemaState[] {
		const token = String(requestToken || '').trim();
		const changed: KustoSupplementalSchemaState[] = [];
		for (const state of this.getStatesForSchemaKey(schemaKey)) {
			const mutable = this.getMutable(this.identity(state as MutableState));
			if (!mutable || (token && mutable.requestToken !== token)) continue;
			const model = this.models.get(mutable.modelUri);
			mutable.fetchedAvailable = true;
			mutable.deadlineAt = undefined;
			mutable.failureKind = undefined;
			this.transitionMutable(mutable, model?.primaryReady ? 'fetched' : 'waiting-primary', now);
			changed.push(freezeState(mutable));
		}
		return changed;
	}

	markFetchedByRequest(requestToken: string, now: number = Date.now()): KustoSupplementalSchemaState[] {
		const token = String(requestToken || '').trim();
		if (!token) return [];
		const changed: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			for (const state of model.references.values()) {
				if (state.requestToken !== token || state.status !== 'fetching') continue;
				state.fetchedAvailable = true;
				state.deadlineAt = undefined;
				state.failureKind = undefined;
				this.transitionMutable(state, model.primaryReady ? 'fetched' : 'waiting-primary', now);
				changed.push(freezeState(state));
			}
		}
		return changed;
	}

	markFetched(identity: KustoSupplementalStateIdentity, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state) return this.stale(identity);
		const model = this.models.get(identity.modelUri);
		state.fetchedAvailable = true;
		state.deadlineAt = undefined;
		state.failureKind = undefined;
		this.transitionMutable(state, model?.primaryReady ? 'fetched' : 'waiting-primary', now);
		return freezeState(state);
	}

	markApplying(identity: KustoSupplementalStateIdentity, deadlineAt: number, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state || !state.fetchedAvailable) return this.stale(identity);
		const model = this.models.get(identity.modelUri);
		if (!model?.primaryReady) {
			this.transitionMutable(state, 'waiting-primary', now);
			return freezeState(state);
		}
		state.deadlineAt = deadlineAt;
		state.failureKind = undefined;
		this.transitionMutable(state, 'applying', now);
		return freezeState(state);
	}

	markLoaded(identity: KustoSupplementalStateIdentity, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state || !state.fetchedAvailable) return this.stale(identity);
		state.deadlineAt = undefined;
		state.failureKind = undefined;
		this.transitionMutable(state, 'loaded', now);
		return freezeState(state);
	}

	markFailed(identity: KustoSupplementalStateIdentity, failureKind: KustoSupplementalFailureKind, now: number = Date.now()): KustoSupplementalSchemaState | undefined {
		const state = this.getMutable(identity);
		if (!state) return this.stale(identity);
		state.deadlineAt = undefined;
		state.failureKind = failureKind;
		state.fetchedAvailable = false;
		this.transitionMutable(state, 'failed', now);
		return freezeState(state);
	}

	markRequestFailed(requestToken: string, failureKind: KustoSupplementalFailureKind, now: number = Date.now()): KustoSupplementalSchemaState[] {
		const token = String(requestToken || '').trim();
		if (!token) return [];
		const changed: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			for (const state of model.references.values()) {
				if (state.requestToken !== token || state.status !== 'fetching') continue;
				if (state.fetchedAvailable) {
					state.deadlineAt = undefined;
					state.failureKind = undefined;
					this.transitionMutable(state, model.primaryReady ? 'loaded' : 'waiting-primary', now);
					changed.push(freezeState(state));
					continue;
				}
				const next = this.markFailed(this.identity(state), failureKind, now);
				if (next) changed.push(next);
			}
		}
		return changed;
	}

	expire(now: number = Date.now()): KustoSupplementalSchemaState[] {
		const expired: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			for (const state of model.references.values()) {
				if (state.status !== 'fetching' && state.status !== 'applying') continue;
				if (!state.deadlineAt || state.deadlineAt > now) continue;
				const failureKind: KustoSupplementalFailureKind = state.status === 'applying' ? 'apply-timeout' : 'fetch-timeout';
				if (state.status === 'fetching' && state.fetchedAvailable) {
					state.deadlineAt = undefined;
					state.failureKind = undefined;
					this.transitionMutable(state, model.primaryReady ? 'loaded' : 'waiting-primary', now);
					expired.push(freezeState(state));
					continue;
				}
				const next = this.markFailed(this.identity(state), failureKind, now);
				if (next) {
					expired.push(next);
					this.emit({
						event: 'deadline-expired',
						modelId: kustoSupplementalTraceId(state.modelUri),
						schemaId: kustoSupplementalTraceId(state.schemaKey),
						status: next.status,
						failureKind,
					});
				}
			}
		}
		return expired;
	}

	invalidateModelApplications(modelUri: string, now: number = Date.now()): KustoSupplementalSchemaState[] {
		const model = this.models.get(String(modelUri || '').trim());
		if (!model) return [];
		const changed: KustoSupplementalSchemaState[] = [];
		for (const state of model.references.values()) {
			if (!state.fetchedAvailable || state.status === 'failed') continue;
			state.deadlineAt = undefined;
			this.transitionMutable(state, 'waiting-primary', now);
			changed.push(freezeState(state));
		}
		return changed;
	}

	disposeModel(modelUri: string): KustoSupplementalSchemaState[] {
		const uri = String(modelUri || '').trim();
		const model = this.models.get(uri);
		if (!model) return [];
		const removed = Array.from(model.references.values(), freezeState);
		this.models.delete(uri);
		this.emit({ event: 'model-disposed', modelId: kustoSupplementalTraceId(uri), removedCount: removed.length });
		return removed;
	}

	getState(modelUri: string, schemaKey: string): KustoSupplementalSchemaState | undefined {
		const state = this.models.get(String(modelUri || '').trim())?.references.get(String(schemaKey || '').trim());
		return state ? freezeState(state) : undefined;
	}

	getStatesForSchemaKey(schemaKey: string): KustoSupplementalSchemaState[] {
		const key = String(schemaKey || '').trim();
		const states: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			const state = model.references.get(key);
			if (state) states.push(freezeState(state));
		}
		return states;
	}

	getStatesForRequest(requestToken: string): KustoSupplementalSchemaState[] {
		const token = String(requestToken || '').trim();
		return token ? this.getAllStates().filter(state => state.requestToken === token) : [];
	}

	getStatesForModel(modelUri: string): KustoSupplementalSchemaState[] {
		const model = this.models.get(String(modelUri || '').trim());
		return model ? Array.from(model.references.values(), freezeState) : [];
	}

	getAllStates(): KustoSupplementalSchemaState[] {
		const states: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			for (const state of model.references.values()) states.push(freezeState(state));
		}
		return states;
	}

	getApplyCandidates(schemaKey?: string): KustoSupplementalSchemaState[] {
		const key = String(schemaKey || '').trim();
		const states: KustoSupplementalSchemaState[] = [];
		for (const model of this.models.values()) {
			if (!model.primaryReady) continue;
			for (const state of model.references.values()) {
				if (key && state.schemaKey !== key) continue;
				if (state.fetchedAvailable && (state.status === 'fetched' || state.status === 'waiting-primary')) states.push(freezeState(state));
			}
		}
		return states;
	}

	getNextDeadlineAt(): number | undefined {
		let next: number | undefined;
		for (const state of this.getAllStates()) {
			if (!state.deadlineAt) continue;
			if (next === undefined || state.deadlineAt < next) next = state.deadlineAt;
		}
		return next;
	}

	invalidateAllApplications(now: number = Date.now()): KustoSupplementalSchemaState[] {
		const changed: KustoSupplementalSchemaState[] = [];
		for (const modelUri of Array.from(this.models.keys())) {
			changed.push(...this.invalidateModelApplications(modelUri, now));
		}
		return changed;
	}

	shouldSuppressDiagnostic(modelUri: string, schemaKey: string, now: number = Date.now()): boolean {
		const state = this.models.get(String(modelUri || '').trim())?.references.get(String(schemaKey || '').trim());
		if (!state || state.status === 'failed') return false;
		if (state.deadlineAt && state.deadlineAt <= now) return false;
		return SUPPRESSED_STATUSES.has(state.status);
	}

	private getMutable(identity: KustoSupplementalStateIdentity): MutableState | undefined {
		const state = this.models.get(String(identity.modelUri || '').trim())?.references.get(String(identity.schemaKey || '').trim());
		return state && state.referenceGeneration === identity.referenceGeneration ? state : undefined;
	}

	private stale(identity: KustoSupplementalStateIdentity): undefined {
		this.emit({
			event: 'stale-transition',
			modelId: kustoSupplementalTraceId(String(identity.modelUri || '')),
			schemaId: kustoSupplementalTraceId(String(identity.schemaKey || '')),
		});
		return undefined;
	}

	private identity(state: MutableState): KustoSupplementalStateIdentity {
		return Object.freeze({ modelUri: state.modelUri, schemaKey: state.schemaKey, referenceGeneration: state.referenceGeneration });
	}

	private transitionMutable(state: MutableState, status: KustoSupplementalSchemaStatus, now: number): void {
		const previousStatus = state.status;
		state.status = status;
		state.updatedAt = now;
		if (previousStatus === status) return;
		this.emit({
			event: 'state-transition',
			modelId: kustoSupplementalTraceId(state.modelUri),
			schemaId: kustoSupplementalTraceId(state.schemaKey),
			status,
			previousStatus,
			requestSource: state.requestSource,
			failureKind: state.failureKind,
		});
	}

	private emit(event: KustoSupplementalCoordinatorTrace): void {
		try { this.trace?.(Object.freeze({ ...event })); } catch { /* tracing must never affect schema state */ }
	}
}

export function supplementalStateIdentity(state: KustoSupplementalSchemaState): KustoSupplementalStateIdentity {
	return Object.freeze({
		modelUri: state.modelUri,
		schemaKey: state.schemaKey,
		referenceGeneration: state.referenceGeneration,
	});
}
