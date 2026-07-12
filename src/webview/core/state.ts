import {
	completeKustoSchemaPreparationDeadline,
	observeKustoSchemaPreparationOwnerTimeout,
} from '../shared/kusto-schema-preparation-deadline.js';
// State module — central webview state.
// All state variables are exported for direct ES module import within the
// esbuild-bundled IIFE.  Window assignments are kept alongside exports so
// that Monaco AMD code, the browser-ext, and queryEditor.js bootstrap can
// still read/write via window.*.

const _win = window;

// ---------------------------------------------------------------------------
// Reference-type state (mutated in-place — safe to export directly)
// ---------------------------------------------------------------------------
export const cachedDatabases: Record<string, any> = {};
export const favoritesModeByBoxId: Record<string, any> = {};
export const pendingFavoriteSelectionByBoxId: Record<string, any> = {};
export const queryEditors: Record<string, any> = {};
export const queryEditorResizeObservers: Record<string, any> = {};
export const queryEditorVisibilityObservers: Record<string, any> = {};
export const queryEditorVisibilityMutationObservers: Record<string, any> = {};
export const queryEditorBoxByModelUri: Record<string, any> = {};
export const schemaByBoxId: Record<string, any> = {};
export const schemaDiagnosticsTrustedByBoxId: Record<string, boolean> = {};
export const schemaFetchInFlightByBoxId: Record<string, any> = {};
export const lastSchemaRequestAtByBoxId: Record<string, any> = {};
export const qualifyTablesInFlightByBoxId: Record<string, any> = {};
export const schemaByConnDb: Record<string, any> = {};
export const schemaMetaByConnDb: Record<string, any> = {};
export const schemaMetaByBoxId: Record<string, any> = {};
export const schemaRequestResolversByBoxId: Record<string, any> = {};
export const databasesRequestResolversByBoxId: Record<string, any> = {};
export const databaseRequestTokenByBoxId: Record<string, string | undefined> = {};
export type KustoPreparationStatus = 'idle' | 'preparing' | 'ready' | 'error';
export type KustoPreparationStage = 'idle' | 'databases' | 'schema' | 'refreshing' | 'waiting-worker' | 'enhancing' | 'ready' | 'error';
export type KustoPreparationBlocker = 'databases' | 'schema' | 'refresh' | 'worker' | 'enhancement';
export type KustoPreparationToken = Readonly<{
	boxId: string;
	generation: number;
	revision: number;
}>;
export type KustoPreparationTarget = Readonly<{
	connectionId?: string;
	database?: string;
	schemaKey?: string;
	schemaSignature?: string;
	modelUri?: string;
	requestToken?: string;
}>;
export type KustoPreparationState = Readonly<{
	status: KustoPreparationStatus;
	stage: KustoPreparationStage;
	generation: number;
	revision: number;
	blockers: readonly KustoPreparationBlocker[];
	target: KustoPreparationTarget;
	usableFallback: boolean;
	error?: string;
	updatedAt: number;
}>;
export type KustoPreparationStartOptions = {
	stage: KustoPreparationStage;
	blockers?: readonly KustoPreparationBlocker[];
	target?: KustoPreparationTarget;
	usableFallback?: boolean;
};
export type KustoPreparationUpdate = {
	stage?: KustoPreparationStage;
	addBlockers?: readonly KustoPreparationBlocker[];
	removeBlockers?: readonly KustoPreparationBlocker[];
	replaceBlockers?: readonly KustoPreparationBlocker[];
	target?: Partial<KustoPreparationTarget>;
	usableFallback?: boolean;
	status?: KustoPreparationStatus;
	error?: string;
};
export type SchemaWorkerReadyState = {
	status: 'pending' | 'ready' | 'error';
	schemaKey?: string;
	schemaSignature?: string;
	modelUri?: string;
	updatedAt: number;
};
export type SchemaEnhancementReadyState = {
	status: 'pending' | 'ready' | 'error';
	schemaKey: string;
	schemaSignature?: string;
	modelUri: string;
	updatedAt: number;
};
export type PendingSchemaWorkerUpdate = {
	rawSchemaJson: any;
	clusterUrl: string;
	database: string;
	schemaKey: string;
	schemaSignature?: string;
	forceRefresh?: boolean;
	reason?: string;
	preparationToken?: KustoPreparationToken;
	backgroundOnly?: boolean;
};
export const kustoPreparationByBoxId: Record<string, KustoPreparationState | undefined> = {};
export const schemaWorkerReadyByBoxId: Record<string, SchemaWorkerReadyState | undefined> = {};
export const schemaEnhancementReadyByBoxId: Record<string, SchemaEnhancementReadyState | undefined> = {};
export const schemaWorkerApplyRequiredByBoxId: Record<string, boolean | undefined> = {};
export const schemaWorkerReadyWaitersByBoxId: Record<string, Array<{ schemaKey?: string; modelUri?: string; resolve: (ready: boolean) => void }>> = {};
export const pendingSchemaWorkerUpdateByBoxId: Record<string, PendingSchemaWorkerUpdate | undefined> = {};
export const missingClusterDetectTimersByBoxId: Record<string, any> = {};
export const lastQueryTextByBoxId: Record<string, any> = {};
export const missingClusterUrlsByBoxId: Record<string, any> = {};
export const optimizationMetadataByBoxId: Record<string, any> = {};
export const suggestedDatabaseByClusterKeyByBoxId: Record<string, any> = {};
export const queryExecutionTimers: Record<string, any> = {};
export const runModesByBoxId: Record<string, any> = {};
export const caretDocOverlaysByBoxId: Record<string, any> = {};
export const copilotInlineCompletionRequests: Record<string, any> = {};
export const sqlConnections: any[] = [];
export const sqlCachedDatabases: Record<string, any> = {};
export const sqlFavoritesModeByBoxId: Record<string, any> = {};

// ---------------------------------------------------------------------------
// Primitive / reassigned state (need setter functions for cross-module writes)
// ---------------------------------------------------------------------------
export let connections: any[] = [];
export let queryBoxes: any[] = [];
export let lastConnectionId: string | null = null;
export let lastDatabase: string | null = null;
export let kustoFavorites: any[] = [];
export let sqlFavorites: any[] = [];
export let leaveNoTraceClusters: string[] = [];
export let activeQueryEditorBoxId: string | null = null;
export let monacoReadyPromise: Promise<void> | null = null;
export let activeMonacoEditor: any = null;
export let caretDocsEnabled = true;
export let autoTriggerAutocompleteEnabled = true;
export let copilotInlineCompletionsEnabled = true;

type KustoSchemaApplyRequester = (boxId: string, enableMarkers: boolean) => boolean;
let kustoSchemaApplyRequester: KustoSchemaApplyRequester | null = null;
const pendingKustoSchemaApplyByBoxId = new Map<string, boolean>();

// Setter functions — update the module-local variable AND window.
export function setConnections(val: any[]) { connections = val; try { _win.connections = val; } catch (e) { console.error('[kusto]', e); } }
export function setQueryBoxes(val: any[]) { queryBoxes = val; try { _win.queryBoxes = val; } catch (e) { console.error('[kusto]', e); } }
export function setLastConnectionId(val: string | null) { lastConnectionId = val; try { _win.lastConnectionId = val; } catch (e) { console.error('[kusto]', e); } }
export function setLastDatabase(val: string | null) { lastDatabase = val; try { _win.lastDatabase = val; } catch (e) { console.error('[kusto]', e); } }
export function setKustoFavorites(val: any[]) { kustoFavorites = val; try { _win.kustoFavorites = val; } catch (e) { console.error('[kusto]', e); } }
export function setSqlFavorites(val: any[]) { sqlFavorites = val; try { _win.sqlFavorites = val; } catch (e) { console.error('[kusto]', e); } }
export function setLeaveNoTraceClusters(val: string[]) { leaveNoTraceClusters = val; try { _win.leaveNoTraceClusters = val; } catch (e) { console.error('[kusto]', e); } }
export function setActiveQueryEditorBoxId(val: string | null) { activeQueryEditorBoxId = val; try { _win.activeQueryEditorBoxId = val; } catch (e) { console.error('[kusto]', e); } }
export function setMonacoReadyPromise(val: Promise<void> | null) { monacoReadyPromise = val; try { _win.monacoReadyPromise = val; } catch (e) { console.error('[kusto]', e); } }
export function setActiveMonacoEditor(val: any) { activeMonacoEditor = val; try { _win.activeMonacoEditor = val; } catch (e) { console.error('[kusto]', e); } }
export function setCaretDocsEnabled(val: boolean) { caretDocsEnabled = val; try { _win.caretDocsEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setAutoTriggerAutocompleteEnabled(val: boolean) { autoTriggerAutocompleteEnabled = val; try { _win.autoTriggerAutocompleteEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setCopilotInlineCompletionsEnabled(val: boolean) { copilotInlineCompletionsEnabled = val; try { _win.copilotInlineCompletionsEnabled = val; } catch (e) { console.error('[kusto]', e); } }
export function setSqlConnections(val: any[]) { sqlConnections.length = 0; sqlConnections.push(...val); try { _win.sqlConnections = sqlConnections; } catch (e) { console.error('[kusto]', e); } }

export function registerKustoSchemaApplyRequester(requester: KustoSchemaApplyRequester): () => void {
	kustoSchemaApplyRequester = requester;
	for (const [boxId, enableMarkers] of Array.from(pendingKustoSchemaApplyByBoxId.entries())) {
		if (requester(boxId, enableMarkers)) pendingKustoSchemaApplyByBoxId.delete(boxId);
	}
	return () => {
		if (kustoSchemaApplyRequester === requester) kustoSchemaApplyRequester = null;
	};
}

export function requestKustoSchemaApplyForBox(boxId: string, enableMarkers: boolean = true): boolean {
	const id = String(boxId || '').trim();
	if (!id) return false;
	if (kustoSchemaApplyRequester?.(id, enableMarkers)) {
		pendingKustoSchemaApplyByBoxId.delete(id);
		return true;
	}
	pendingKustoSchemaApplyByBoxId.set(id, (pendingKustoSchemaApplyByBoxId.get(id) || false) || enableMarkers);
	return true;
}

let kustoPreparationGeneration = 0;
const kustoPreparationListenersByBoxId = new Map<string, Set<(state: KustoPreparationState) => void>>();

function uniquePreparationBlockers(values: readonly KustoPreparationBlocker[]): KustoPreparationBlocker[] {
	return Array.from(new Set(values));
}

function stageForPreparationBlockers(blockers: readonly KustoPreparationBlocker[]): KustoPreparationStage {
	if (blockers.includes('enhancement')) return 'enhancing';
	if (blockers.includes('worker')) return 'waiting-worker';
	if (blockers.includes('refresh')) return 'refreshing';
	if (blockers.includes('schema')) return 'schema';
	if (blockers.includes('databases')) return 'databases';
	return 'ready';
}

function publishKustoPreparation(boxId: string, state: KustoPreparationState): void {
	kustoPreparationByBoxId[boxId] = state;
	if (state.status !== 'preparing') {
		completeKustoSchemaPreparationDeadline({ boxId, generation: state.generation });
	}
	const listeners = kustoPreparationListenersByBoxId.get(boxId);
	if (!listeners) return;
	for (const listener of Array.from(listeners)) {
		try { listener(state); } catch (e) { console.error('[kusto]', e); }
	}
}

function createKustoPreparationState(args: {
	status: KustoPreparationStatus;
	stage: KustoPreparationStage;
	generation: number;
	revision: number;
	blockers?: readonly KustoPreparationBlocker[];
	target?: KustoPreparationTarget;
	usableFallback?: boolean;
	error?: string;
}): KustoPreparationState {
	return Object.freeze({
		status: args.status,
		stage: args.stage,
		generation: args.generation,
		revision: args.revision,
		blockers: Object.freeze(uniquePreparationBlockers(args.blockers || [])),
		target: Object.freeze({ ...(args.target || {}) }),
		usableFallback: !!args.usableFallback,
		...(args.error ? { error: args.error } : {}),
		updatedAt: Date.now(),
	});
}

export function getKustoPreparationState(boxId: string): KustoPreparationState {
	const id = String(boxId || '').trim();
	const current = id ? kustoPreparationByBoxId[id] : undefined;
	if (current) return current;
	return createKustoPreparationState({
		status: 'idle',
		stage: 'idle',
		generation: 0,
		revision: 0,
	});
}

export function getKustoPreparationToken(boxId: string): KustoPreparationToken | undefined {
	const id = String(boxId || '').trim();
	const current = id ? kustoPreparationByBoxId[id] : undefined;
	return current ? Object.freeze({ boxId: id, generation: current.generation, revision: current.revision }) : undefined;
}

export function isKustoPreparationCurrent(token: KustoPreparationToken | undefined, expected: Partial<KustoPreparationTarget> = {}): boolean {
	if (!token) return false;
	const current = kustoPreparationByBoxId[token.boxId];
	if (!current || current.generation !== token.generation || current.revision !== token.revision) return false;
	for (const [key, value] of Object.entries(expected)) {
		if (value !== undefined && current.target[key as keyof KustoPreparationTarget] !== value) return false;
	}
	return true;
}

export function discardStalePendingSchemaWorkerUpdate(boxId: string): boolean {
	const id = String(boxId || '').trim();
	const pending = id ? pendingSchemaWorkerUpdateByBoxId[id] : undefined;
	const token = pending?.preparationToken;
	if (!pending || !token || isKustoPreparationCurrent(token, {
		schemaKey: pending.schemaKey,
		schemaSignature: pending.schemaSignature,
	})) {
		return false;
	}
	if (pendingSchemaWorkerUpdateByBoxId[id] === pending) {
		delete pendingSchemaWorkerUpdateByBoxId[id];
	}
	return true;
}

export function beginKustoPreparation(boxId: string, options: KustoPreparationStartOptions): KustoPreparationToken | undefined {
	const id = String(boxId || '').trim();
	if (!id) return undefined;
	const generation = ++kustoPreparationGeneration;
	const blockers = uniquePreparationBlockers(options.blockers || []);
	const status: KustoPreparationStatus = blockers.length ? 'preparing' : 'ready';
	const stage = status === 'ready' ? 'ready' : options.stage;
	publishKustoPreparation(id, createKustoPreparationState({
		status,
		stage,
		generation,
		revision: 0,
		blockers,
		target: options.target,
		usableFallback: options.usableFallback,
	}));
	return Object.freeze({ boxId: id, generation, revision: 0 });
}

export function reviseKustoPreparation(token: KustoPreparationToken | undefined, update: KustoPreparationUpdate = {}): KustoPreparationToken | undefined {
	if (!isKustoPreparationCurrent(token) || !token) return undefined;
	const current = kustoPreparationByBoxId[token.boxId]!;
	const revision = current.revision + 1;
	const nextToken = Object.freeze({ boxId: token.boxId, generation: current.generation, revision });
	const replaceBlockers = update.replaceBlockers ?? current.blockers;
	const blockers = uniquePreparationBlockers([
		...replaceBlockers.filter(blocker => !(update.removeBlockers || []).includes(blocker)),
		...(update.addBlockers || []),
	]);
	const status = update.status ?? (blockers.length ? 'preparing' : 'ready');
	const stage = status === 'error' ? 'error'
		: status === 'idle' ? 'idle'
			: status === 'ready' ? 'ready'
				: (update.stage || stageForPreparationBlockers(blockers));
	publishKustoPreparation(token.boxId, createKustoPreparationState({
		status,
		stage,
		generation: current.generation,
		revision,
		blockers,
		target: { ...current.target, ...(update.target || {}) },
		usableFallback: update.usableFallback ?? current.usableFallback,
		error: update.error,
	}));
	return nextToken;
}

export function updateKustoPreparation(token: KustoPreparationToken | undefined, update: KustoPreparationUpdate): boolean {
	if (!isKustoPreparationCurrent(token) || !token) return false;
	const current = kustoPreparationByBoxId[token.boxId]!;
	const replaceBlockers = update.replaceBlockers ?? current.blockers;
	const blockers = uniquePreparationBlockers([
		...replaceBlockers.filter(blocker => !(update.removeBlockers || []).includes(blocker)),
		...(update.addBlockers || []),
	]);
	const status = update.status ?? (blockers.length ? 'preparing' : 'ready');
	const stage = status === 'error' ? 'error'
		: status === 'idle' ? 'idle'
			: status === 'ready' ? 'ready'
				: (update.stage || stageForPreparationBlockers(blockers));
	publishKustoPreparation(token.boxId, createKustoPreparationState({
		status,
		stage,
		generation: current.generation,
		revision: current.revision,
		blockers,
		target: { ...current.target, ...(update.target || {}) },
		usableFallback: update.usableFallback ?? current.usableFallback,
		error: update.error,
	}));
	return true;
}

export function setKustoPreparationIdle(boxId: string): KustoPreparationToken | undefined {
	const id = String(boxId || '').trim();
	if (!id) return undefined;
	const generation = ++kustoPreparationGeneration;
	publishKustoPreparation(id, createKustoPreparationState({ status: 'idle', stage: 'idle', generation, revision: 0 }));
	return Object.freeze({ boxId: id, generation, revision: 0 });
}

export function failKustoPreparation(token: KustoPreparationToken | undefined, error: string, usableFallback: boolean = false): boolean {
	if (!isKustoPreparationCurrent(token) || !token) return false;
	const current = kustoPreparationByBoxId[token.boxId];
	if (usableFallback) {
		if (current?.status === 'error') {
			return !!reviseKustoPreparation(token, {
				status: 'error',
				stage: 'error',
				replaceBlockers: [],
				usableFallback: true,
				error: current.error || String(error || 'Preparation failed'),
			});
		}
		return updateKustoPreparation(token, { removeBlockers: ['refresh'], usableFallback: true });
	}
	return !!reviseKustoPreparation(token, {
		status: 'error',
		stage: 'error',
		replaceBlockers: [],
		usableFallback: false,
		error: String(error || 'Preparation failed'),
	});
}

export function disposeKustoPreparation(boxId: string): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const generation = ++kustoPreparationGeneration;
	publishKustoPreparation(id, createKustoPreparationState({ status: 'idle', stage: 'idle', generation, revision: 0 }));
	delete kustoPreparationByBoxId[id];
	delete schemaWorkerApplyRequiredByBoxId[id];
	pendingKustoSchemaApplyByBoxId.delete(id);
}

export function subscribeKustoPreparation(boxId: string, listener: (state: KustoPreparationState) => void): () => void {
	const id = String(boxId || '').trim();
	if (!id) return () => undefined;
	let listeners = kustoPreparationListenersByBoxId.get(id);
	if (!listeners) {
		listeners = new Set();
		kustoPreparationListenersByBoxId.set(id, listeners);
	}
	listeners.add(listener);
	listener(getKustoPreparationState(id));
	return () => {
		const current = kustoPreparationListenersByBoxId.get(id);
		current?.delete(listener);
		if (current?.size === 0) kustoPreparationListenersByBoxId.delete(id);
	};
}

function resolveSchemaWorkerWaiters(boxId: string, ready: boolean, schemaKey?: string, modelUri?: string): void {
	try {
		const waiters = schemaWorkerReadyWaitersByBoxId[boxId];
		if (!waiters || waiters.length === 0) {
			return;
		}
		const remaining: typeof waiters = [];
		for (const waiter of waiters) {
			const schemaMatches = !waiter.schemaKey || !schemaKey || waiter.schemaKey === schemaKey;
			const modelMatches = !waiter.modelUri || (!!modelUri && waiter.modelUri === modelUri);
			if (schemaMatches && modelMatches) {
				try { waiter.resolve(ready); } catch (e) { console.error('[kusto]', e); }
			} else {
				remaining.push(waiter);
			}
		}
		if (remaining.length) {
			schemaWorkerReadyWaitersByBoxId[boxId] = remaining;
		} else {
			delete schemaWorkerReadyWaitersByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function markSchemaWorkerApplyPending(boxId: string, schemaKey: string, schemaSignature?: string, modelUri?: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken))) return;
	schemaWorkerReadyByBoxId[id] = { status: 'pending', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
	if (preparationToken) {
		updateKustoPreparation(preparationToken, {
			stage: 'waiting-worker',
			addBlockers: ['worker'],
			target: { schemaKey, schemaSignature, modelUri },
		});
		observeKustoSchemaPreparationOwnerTimeout(preparationToken, () => {
			if (isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri })) {
				markSchemaWorkerApplyFailed(boxId, schemaKey, modelUri, preparationToken);
			}
		});
	}
}

export function markSchemaWorkerReady(boxId: string, schemaKey: string, schemaSignature?: string, modelUri?: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri }))) return;
	schemaWorkerReadyByBoxId[id] = { status: 'ready', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
	delete schemaWorkerApplyRequiredByBoxId[id];
	resolveSchemaWorkerWaiters(id, true, schemaKey, modelUri);
	if (preparationToken) {
		// The base worker schema is the user-visible readiness boundary. Function
		// output inference continues in the background and must not hold the toolbar
		// progress indicator after Monaco can already serve semantic completions.
		updateKustoPreparation(preparationToken, { removeBlockers: ['schema', 'worker', 'enhancement'] });
	}
}

export function markSchemaWorkerApplyFailed(boxId: string, schemaKey?: string, modelUri?: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken))) return;
	schemaWorkerReadyByBoxId[id] = { status: 'error', schemaKey, modelUri, updatedAt: Date.now() };
	resolveSchemaWorkerWaiters(id, false, schemaKey, modelUri);
	if (preparationToken) {
		failKustoPreparation(preparationToken, 'Failed to prepare autocomplete.');
	}
}

function schemaEnhancementMatches(state: SchemaEnhancementReadyState | undefined, schemaKey: string, schemaSignature: string | undefined, modelUri: string): boolean {
	return !!state
		&& state.schemaKey === schemaKey
		&& state.schemaSignature === schemaSignature
		&& state.modelUri === modelUri;
}

export function markSchemaEnhancementPending(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri }))) return;
	schemaEnhancementReadyByBoxId[id] = { status: 'pending', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
}

export function markSchemaEnhancementReady(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri }))) return;
	schemaEnhancementReadyByBoxId[id] = { status: 'ready', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
	if (preparationToken) updateKustoPreparation(preparationToken, { removeBlockers: ['enhancement'] });
}

export function markSchemaEnhancementFailed(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id || (preparationToken && !isKustoPreparationCurrent(preparationToken, { schemaKey, schemaSignature, modelUri }))) return;
	schemaEnhancementReadyByBoxId[id] = { status: 'error', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
	// Enhancement is retryable background enrichment. The exact base worker
	// schema remains valid even when inference fails.
	if (preparationToken) updateKustoPreparation(preparationToken, { removeBlockers: ['enhancement'] });
}

export function markSchemaEnhancementCanceled(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string, preparationToken?: KustoPreparationToken): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const state = schemaEnhancementReadyByBoxId[id];
	if (!schemaEnhancementMatches(state, schemaKey, schemaSignature, modelUri) || state?.status !== 'pending') return;
	schemaEnhancementReadyByBoxId[id] = { status: 'error', schemaKey, schemaSignature, modelUri, updatedAt: Date.now() };
}

export function isSchemaEnhancementReady(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string): boolean {
	const state = schemaEnhancementReadyByBoxId[String(boxId || '').trim()];
	return schemaEnhancementMatches(state, schemaKey, schemaSignature, modelUri) && state?.status === 'ready';
}

export function isSchemaEnhancementPending(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string): boolean {
	const state = schemaEnhancementReadyByBoxId[String(boxId || '').trim()];
	return schemaEnhancementMatches(state, schemaKey, schemaSignature, modelUri) && state?.status === 'pending';
}

export function isSchemaEnhancementFailed(boxId: string, schemaKey: string, schemaSignature: string | undefined, modelUri: string): boolean {
	const state = schemaEnhancementReadyByBoxId[String(boxId || '').trim()];
	return schemaEnhancementMatches(state, schemaKey, schemaSignature, modelUri) && state?.status === 'error';
}

export function isSchemaWorkerReady(boxId: string, schemaKey?: string, modelUri?: string): boolean {
	const id = String(boxId || '').trim();
	if (!id) return false;
	const state = schemaWorkerReadyByBoxId[id];
	if (!state || state.status !== 'ready') return false;
	if (schemaKey && state.schemaKey !== schemaKey) return false;
	if (modelUri && state.modelUri !== modelUri) return false;
	return true;
}

export function requireSchemaWorkerApply(boxId: string): void {
	const id = String(boxId || '').trim();
	if (id) schemaWorkerApplyRequiredByBoxId[id] = true;
}

export function isSchemaWorkerApplyRequired(boxId: string): boolean {
	return schemaWorkerApplyRequiredByBoxId[String(boxId || '').trim()] === true;
}

export function waitForSchemaWorkerReady(boxId: string, schemaKey?: string, timeoutMs: number = 900, modelUri?: string): Promise<boolean> {
	const id = String(boxId || '').trim();
	if (!id) return Promise.resolve(false);
	if (isSchemaWorkerReady(id, schemaKey, modelUri)) {
		return Promise.resolve(true);
	}
	return new Promise(resolve => {
		let settled = false;
		let timeoutId: number | undefined;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			if (timeoutId !== undefined) {
				try { clearTimeout(timeoutId); } catch (e) { console.error('[kusto]', e); }
			}
			resolve(ready);
		};
		try {
			(schemaWorkerReadyWaitersByBoxId[id] = schemaWorkerReadyWaitersByBoxId[id] || []).push({ schemaKey, modelUri, resolve: finish });
			timeoutId = window.setTimeout(() => {
				try {
					const waiters = schemaWorkerReadyWaitersByBoxId[id] || [];
					schemaWorkerReadyWaitersByBoxId[id] = waiters.filter(waiter => waiter.resolve !== finish);
					if (schemaWorkerReadyWaitersByBoxId[id].length === 0) {
						delete schemaWorkerReadyWaitersByBoxId[id];
					}
				} catch (e) { console.error('[kusto]', e); }
				finish(isSchemaWorkerReady(id, schemaKey, modelUri));
			}, Math.max(0, timeoutMs));
		} catch {
			finish(false);
		}
	});
}

export function invalidateSchemaWorkerReadinessForBox(boxId: string, resetPreparation: boolean = true, resetEnhancement: boolean = true): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	delete schemaWorkerReadyByBoxId[id];
	if (resetEnhancement) delete schemaEnhancementReadyByBoxId[id];
	const waiters = schemaWorkerReadyWaitersByBoxId[id] || [];
	delete schemaWorkerReadyWaitersByBoxId[id];
	for (const waiter of waiters) {
		try { waiter.resolve(false); } catch (e) { console.error('[kusto]', e); }
	}
	if (resetPreparation && kustoPreparationByBoxId[id]?.status !== 'idle') {
		setKustoPreparationIdle(id);
	}
}

export function invalidateSchemaWorkerReadiness(exceptBoxId?: string): void {
	const except = String(exceptBoxId || '').trim();
	const ids = new Set([...Object.keys(schemaWorkerReadyByBoxId), ...Object.keys(schemaWorkerReadyWaitersByBoxId)]);
	for (const id of ids) {
		if (!except || id !== except) invalidateSchemaWorkerReadinessForBox(id);
	}
}

// ======================================================================
// Window bridge: expose all state globals for remaining legacy callers
// (Monaco AMD, browser-ext, queryEditor.js bootstrap, Lit components
//  that still read via window.*)
// ======================================================================
_win.connections = connections;
_win.queryBoxes = queryBoxes;
_win.lastConnectionId = lastConnectionId;
_win.lastDatabase = lastDatabase;
_win.cachedDatabases = cachedDatabases;
_win.kustoFavorites = kustoFavorites;
_win.leaveNoTraceClusters = leaveNoTraceClusters;
_win.favoritesModeByBoxId = favoritesModeByBoxId;
_win.pendingFavoriteSelectionByBoxId = pendingFavoriteSelectionByBoxId;
_win.queryEditors = queryEditors;
_win.queryEditorResizeObservers = queryEditorResizeObservers;
_win.queryEditorVisibilityObservers = queryEditorVisibilityObservers;
_win.queryEditorVisibilityMutationObservers = queryEditorVisibilityMutationObservers;
_win.queryEditorBoxByModelUri = queryEditorBoxByModelUri;
_win.activeQueryEditorBoxId = activeQueryEditorBoxId;
_win.schemaByBoxId = schemaByBoxId;
_win.schemaFetchInFlightByBoxId = schemaFetchInFlightByBoxId;
_win.lastSchemaRequestAtByBoxId = lastSchemaRequestAtByBoxId;
_win.monacoReadyPromise = monacoReadyPromise;
_win.qualifyTablesInFlightByBoxId = qualifyTablesInFlightByBoxId;
_win.schemaByConnDb = schemaByConnDb;
_win.schemaRequestResolversByBoxId = schemaRequestResolversByBoxId;
_win.databasesRequestResolversByBoxId = databasesRequestResolversByBoxId;
_win.missingClusterDetectTimersByBoxId = missingClusterDetectTimersByBoxId;
_win.lastQueryTextByBoxId = lastQueryTextByBoxId;
_win.missingClusterUrlsByBoxId = missingClusterUrlsByBoxId;
_win.optimizationMetadataByBoxId = optimizationMetadataByBoxId;
_win.suggestedDatabaseByClusterKeyByBoxId = suggestedDatabaseByClusterKeyByBoxId;
_win.activeMonacoEditor = activeMonacoEditor;
_win.queryExecutionTimers = queryExecutionTimers;
_win.runModesByBoxId = runModesByBoxId;
_win.caretDocsEnabled = caretDocsEnabled;
_win.caretDocOverlaysByBoxId = caretDocOverlaysByBoxId;
_win.autoTriggerAutocompleteEnabled = autoTriggerAutocompleteEnabled;
_win.copilotInlineCompletionsEnabled = copilotInlineCompletionsEnabled;
_win.copilotInlineCompletionRequests = copilotInlineCompletionRequests;
_win.sqlConnections = sqlConnections;
_win.sqlCachedDatabases = sqlCachedDatabases;
_win.sqlFavorites = sqlFavorites;
_win.sqlFavoritesModeByBoxId = sqlFavoritesModeByBoxId;

// Expose setter functions on window so Lit components (same IIFE) can call them
// without creating import dependencies. Only setters that are actually needed
// by Lit components are exposed.
(_win as any).setQueryBoxes = setQueryBoxes;
