import type {
	KustoEditorLifecycleIdentity,
	KustoEditorSchemaRequestIdentity,
	KustoEditorSchemaTarget,
} from '../../shared/kustoSchemaLifecycle.js';

export type KustoEditorSectionLease = Readonly<{
	boxId: string;
	sectionInstanceId: string;
}>;

export type KustoEditorModelLease = KustoEditorSectionLease & Readonly<{
	modelUri: string;
	modelGeneration: number;
}>;

export type KustoEditorSchemaRequestPlan = Readonly<{
	lease: KustoEditorSectionLease;
	modelLease?: KustoEditorModelLease;
	identity: KustoEditorLifecycleIdentity;
	targetBefore: KustoEditorSchemaTarget | undefined;
	target: KustoEditorSchemaTarget;
	requestToken: string;
	previousRequestToken: string | undefined;
}>;

export type KustoEditorOwnedStateSlot =
	| 'schema'
	| 'schemaMeta'
	| 'preparation'
	| 'pendingWorkerUpdate'
	| 'workerReady'
	| 'enhancementReady'
	| 'workerApplyRequired'
	| 'workerReadyWaiters';

export type KustoEditorOwnedStateSnapshot = Readonly<Partial<Record<KustoEditorOwnedStateSlot, unknown>>>;

export type KustoEditorLifecycleEvent =
	| Readonly<{ type: 'opened'; owner: KustoEditorSectionLease }>
	| Readonly<{ type: 'target'; owner: KustoEditorSectionLease & KustoEditorLifecycleIdentity; target?: KustoEditorSchemaTarget }>
	| Readonly<{ type: 'closed'; owner: KustoEditorSectionLease; preserveResultAttachment?: true }>;

export type KustoEditorSchemaDebugEntry = Readonly<{
	boxId: string;
	sectionInstanceId?: string;
	targetGeneration: number;
	hasConnection: boolean;
	hasDatabase: boolean;
	hasDatabaseRequest: boolean;
	hasSchemaRequest: boolean;
	modelAttached: boolean;
	modelGeneration: number;
	catalog: Readonly<{ tables: number; functions: number; hasRawSchema: boolean }>;
	preparation?: Readonly<{
		status: string;
		stage: string;
		generation?: number;
		revision?: number;
		blockers: readonly string[];
		usableFallback: boolean;
	}>;
	worker?: Readonly<{
		status: string;
		hasSchemaKey: boolean;
		hasSchemaSignature: boolean;
		modelMatches: boolean;
		preparationMatches: boolean;
	}>;
	pending?: Readonly<{ reason?: string; backgroundOnly: boolean }>;
}>;

export type KustoEditorSchemaDebugSnapshot = Readonly<{
	sections: readonly KustoEditorSchemaDebugEntry[];
}>;

type KustoEditorRecord = {
	readonly boxId: string;
	sectionInstanceId?: string;
	targetGeneration: number;
	target?: KustoEditorSchemaTarget;
	databaseRequestToken?: string;
	schemaRequestToken?: string;
	modelUri?: string;
	modelGeneration: number;
	readonly ownedState: Partial<Record<KustoEditorOwnedStateSlot, unknown>>;
	readonly listeners: Map<KustoEditorOwnedStateSlot, Set<(value: unknown) => void>>;
};

type ActiveKustoEditorRecord = KustoEditorRecord & { sectionInstanceId: string };

function normalizeId(value: unknown): string {
	return String(value || '').trim();
}

function normalizeTarget(
	connectionId: string,
	database?: string,
	physicalOwner?: { connectionRevision?: number; connectionIdentityKey?: string },
): KustoEditorSchemaTarget | undefined {
	const id = normalizeId(connectionId);
	const normalizedDatabase = normalizeId(database);
	return id ? Object.freeze({
		connectionId: id,
		...(normalizedDatabase ? { database: normalizedDatabase } : {}),
		...(Number.isSafeInteger(physicalOwner?.connectionRevision) && Number(physicalOwner?.connectionRevision) >= 0
			? { connectionRevision: Number(physicalOwner?.connectionRevision) } : {}),
		...(normalizeId(physicalOwner?.connectionIdentityKey)
			? { connectionIdentityKey: normalizeId(physicalOwner?.connectionIdentityKey) } : {}),
	}) : undefined;
}

function targetsEqual(
	left: KustoEditorSchemaTarget | undefined,
	right: KustoEditorSchemaTarget | undefined,
): boolean {
	return logicalTargetsEqual(left, right)
		&& left?.connectionRevision === right?.connectionRevision
		&& normalizeId(left?.connectionIdentityKey) === normalizeId(right?.connectionIdentityKey);
}

function logicalTargetsEqual(
	left: KustoEditorSchemaTarget | undefined,
	right: KustoEditorSchemaTarget | undefined,
): boolean {
	return left?.connectionId === right?.connectionId
		&& normalizeId(left?.database).toLowerCase() === normalizeId(right?.database).toLowerCase();
}

export class KustoEditorSchemaCoordinator {
	private readonly editors = new Map<string, KustoEditorRecord>();
	private readonly tombstonedBoxIds = new Set<string>();
	private readonly lifecycleListeners = new Set<(event: KustoEditorLifecycleEvent) => void>();

	subscribeLifecycle(listener: (event: KustoEditorLifecycleEvent) => void): () => void {
		this.lifecycleListeners.add(listener);
		return () => this.lifecycleListeners.delete(listener);
	}

	openSection(boxId: string, sectionInstanceId: string): KustoEditorSectionLease | undefined {
		const id = normalizeId(boxId);
		const instanceId = normalizeId(sectionInstanceId);
		if (!id || !instanceId) return undefined;
		this.tombstonedBoxIds.delete(id);
		const current = this.editors.get(id);
		if (current && !current.sectionInstanceId) {
			current.sectionInstanceId = instanceId;
		} else if (!current || current.sectionInstanceId !== instanceId) {
			if (current) this.retireRecord(current);
			this.editors.set(id, {
				boxId: id,
				sectionInstanceId: instanceId,
				targetGeneration: 0,
				modelGeneration: 0,
				ownedState: {},
				listeners: new Map(),
			});
		}
		const lease = Object.freeze({ boxId: id, sectionInstanceId: instanceId });
		this.publishLifecycle({ type: 'opened', owner: lease });
		return lease;
	}

	closeSection(
		lease: KustoEditorSectionLease,
		options: Readonly<{ preserveResultAttachment?: boolean }> = {},
	): boolean {
		const current = this.getRecord(lease);
		if (!current) return false;
		this.retireRecord(current);
		this.editors.delete(current.boxId);
		this.tombstonedBoxIds.add(current.boxId);
		this.publishLifecycle({ type: 'closed', owner: Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
		}), ...(options.preserveResultAttachment === true ? { preserveResultAttachment: true } : {}) });
		return true;
	}

	setTarget(
		lease: KustoEditorSectionLease,
		connectionId: string,
		database?: string,
		physicalOwner?: { connectionRevision?: number; connectionIdentityKey?: string },
	): KustoEditorLifecycleIdentity | undefined {
		const current = this.getRecord(lease);
		if (!current) return undefined;
		const target = normalizeTarget(connectionId, database, physicalOwner);
		if (!targetsEqual(current.target, target)) {
			this.retireTargetState(current);
			current.target = target;
		}
		return this.publishTarget(current);
	}

	invalidateTarget(lease: KustoEditorSectionLease): KustoEditorLifecycleIdentity | undefined {
		const current = this.getRecord(lease);
		if (!current) return undefined;
		return this.invalidateRecordTarget(current);
	}

	invalidateCurrentTarget(boxId: string): KustoEditorLifecycleIdentity | undefined {
		const current = this.editors.get(normalizeId(boxId));
		if (!current) return undefined;
		return this.invalidateRecordTarget(current);
	}

	private invalidateRecordTarget(current: KustoEditorRecord): KustoEditorLifecycleIdentity | undefined {
		this.retireTargetState(current);
		return this.publishTarget(current);
	}

	private publishTarget(
		current: KustoEditorRecord,
		identity = this.getIdentity(current.boxId),
		isCurrent?: () => boolean,
	): KustoEditorLifecycleIdentity | undefined {
		if (identity && current.sectionInstanceId) {
			this.publishLifecycle({
				type: 'target',
				owner: Object.freeze({ boxId: current.boxId, sectionInstanceId: identity.sectionInstanceId, targetGeneration: identity.targetGeneration }),
				...(current.target ? { target: Object.freeze({ ...current.target }) } : {}),
			}, isCurrent);
		}
		return identity;
	}

	private publishLifecycle(event: KustoEditorLifecycleEvent, isCurrent?: () => boolean): void {
		for (const listener of [...this.lifecycleListeners]) {
			if (isCurrent && !isCurrent()) break;
			try { listener(event); } catch { /* lifecycle observers cannot break ownership */ }
		}
	}

	beginSchemaRequest(
		lease: KustoEditorSectionLease,
		requestToken: string,
	): KustoEditorSchemaRequestIdentity | undefined {
		const current = this.getRecord(lease);
		if (!current?.target?.connectionId || !current.target.database) return undefined;
		const request = this.createRequestIdentity(current, requestToken);
		if (request) current.schemaRequestToken = request.requestToken;
		return request;
	}

	beginSchemaRequests(
		plans: readonly KustoEditorSchemaRequestPlan[],
		admit: (requests: readonly KustoEditorSchemaRequestIdentity[]) => boolean,
	): readonly KustoEditorSchemaRequestIdentity[] | undefined {
		const staged = plans.map(({ lease, modelLease, identity, targetBefore, target: desired, requestToken, previousRequestToken }) => {
			const target = normalizeTarget(desired.connectionId, desired.database, desired);
			const current = this.getRecord(lease);
			const token = this.getSchemaRequestToken(lease.boxId);
			if (!current || !target?.database || token !== previousRequestToken
				|| (modelLease && (normalizeId(modelLease.boxId) !== current.boxId || !this.isModelLeaseCurrent(modelLease)))) return undefined;
			const instanceId = normalizeId(identity.sectionInstanceId);
			const generation = identity.targetGeneration;
			const { modelUri, modelGeneration } = current;
			const changed = !targetsEqual(current.target, target);
			const request = this.createRequestIdentity(current, requestToken, current.targetGeneration + (changed ? 1 : 0));
			return request ? {
				current, target: changed ? target : targetBefore!, request, changed,
				isCurrent: (expectedGeneration = generation, expectedTarget = targetBefore, expectedToken = token) =>
					this.editors.get(current.boxId) === current && current.sectionInstanceId === instanceId
					&& current.targetGeneration === expectedGeneration && current.target === expectedTarget
					&& current.schemaRequestToken === expectedToken && current.modelUri === modelUri
					&& current.modelGeneration === modelGeneration,
				waiters: changed ? current.ownedState.workerReadyWaiters : undefined,
				ready: changed && 'workerReady' in current.ownedState,
			} : undefined;
		});
		const entries = staged as NonNullable<(typeof staged)[number]>[];
		if (entries.some((entry, index) => !entry || !entry.isCurrent()
			|| entries.findIndex(other => other?.current === entry.current) !== index)) return undefined;
		const requests = Object.freeze(entries.map(entry => entry.request));
		if (!admit(requests) || !entries.every(entry => entry.isCurrent())) return undefined;
		for (const entry of entries) {
			if (entry.changed) {
				this.retireTargetState(entry.current, false);
				entry.current.target = entry.target;
			}
			entry.current.schemaRequestToken = entry.request.requestToken;
		}
		for (const entry of entries) {
			if (entry.changed) this.settleWorkerWaiters(entry.waiters);
			const isCurrent = () => entry.isCurrent(entry.request.targetGeneration, entry.target, entry.request.requestToken);
			try {
				if (entry.ready && isCurrent()) this.publishOwnedStateListeners(entry.current, 'workerReady', undefined, isCurrent);
			} catch (error) { console.error('[kusto]', error); }
			this.publishTarget(entry.current, entry.request, isCurrent);
		}
		return requests;
	}

	beginDatabaseRequest(
		lease: KustoEditorSectionLease,
		requestToken: string,
	): KustoEditorSchemaRequestIdentity | undefined {
		const current = this.getRecord(lease);
		if (!current?.target?.connectionId) return undefined;
		const request = this.createRequestIdentity(current, requestToken);
		if (request) current.databaseRequestToken = request.requestToken;
		return request;
	}

	private createRequestIdentity(
		current: ActiveKustoEditorRecord,
		requestToken: string,
		targetGeneration = current.targetGeneration,
	): KustoEditorSchemaRequestIdentity | undefined {
		const token = normalizeId(requestToken);
		return token ? Object.freeze({ boxId: current.boxId, sectionInstanceId: current.sectionInstanceId, targetGeneration, requestToken: token }) : undefined;
	}

	getIdentity(boxId: string): KustoEditorLifecycleIdentity | undefined {
		const current = this.editors.get(normalizeId(boxId));
		return current?.sectionInstanceId ? Object.freeze({
			sectionInstanceId: current.sectionInstanceId,
			targetGeneration: current.targetGeneration,
		}) : undefined;
	}

	getTarget(boxId: string): KustoEditorSchemaTarget | undefined {
		return this.editors.get(normalizeId(boxId))?.target;
	}

	getSchemaRequestToken(boxId: string): string | undefined {
		return this.editors.get(normalizeId(boxId))?.schemaRequestToken;
	}

	getDatabaseRequestToken(boxId: string): string | undefined {
		return this.editors.get(normalizeId(boxId))?.databaseRequestToken;
	}

	getLease(boxId: string): KustoEditorSectionLease | undefined {
		const current = this.editors.get(normalizeId(boxId));
		return current?.sectionInstanceId ? Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
		}) : undefined;
	}

	getModelLease(boxId: string): KustoEditorModelLease | undefined {
		const current = this.editors.get(normalizeId(boxId));
		return current?.sectionInstanceId && current.modelUri ? Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
			modelUri: current.modelUri,
			modelGeneration: current.modelGeneration,
		}) : undefined;
	}

	getSectionIds(): string[] {
		return [...this.editors.values()]
			.filter(record => !!record.sectionInstanceId)
			.map(record => record.boxId)
			.sort();
	}

	getOwnedState<T>(boxId: string, slot: KustoEditorOwnedStateSlot): T | undefined {
		return this.editors.get(normalizeId(boxId))?.ownedState[slot] as T | undefined;
	}

	setOwnedState<T>(boxId: string, slot: KustoEditorOwnedStateSlot, value: T | undefined): void {
		const id = normalizeId(boxId);
		if (!id) return;
		const current = this.getOrCreateRecord(id);
		if (!current) return;
		if (value === undefined) delete current.ownedState[slot];
		else current.ownedState[slot] = value;
	}

	deleteOwnedState(boxId: string, slot: KustoEditorOwnedStateSlot): boolean {
		const current = this.editors.get(normalizeId(boxId));
		if (!current || !(slot in current.ownedState)) return false;
		delete current.ownedState[slot];
		return true;
	}

	getOwnedStateIds(slot: KustoEditorOwnedStateSlot): string[] {
		const ids: string[] = [];
		for (const [boxId, record] of this.editors) {
			if (slot in record.ownedState) ids.push(boxId);
		}
		return ids;
	}

	clearOwnedStateSlot(slot: KustoEditorOwnedStateSlot): void {
		for (const record of this.editors.values()) {
			if (slot === 'workerReadyWaiters') this.settleWorkerWaiters(record.ownedState.workerReadyWaiters);
			delete record.ownedState[slot];
		}
	}

	getOwnedStateSnapshot(boxId: string): KustoEditorOwnedStateSnapshot {
		const state = this.editors.get(normalizeId(boxId))?.ownedState;
		return Object.freeze({ ...(state || {}) });
	}

	getDebugSnapshot(): KustoEditorSchemaDebugSnapshot {
		const sections = [...this.editors.values()]
			.sort((left, right) => left.boxId.localeCompare(right.boxId))
			.map(record => {
				const schema = this.asRecord(record.ownedState.schema);
				const preparation = this.asRecord(record.ownedState.preparation);
				const preparationTarget = this.asRecord(preparation?.target);
				const worker = this.asRecord(record.ownedState.workerReady);
				const pending = this.asRecord(record.ownedState.pendingWorkerUpdate);
				const tables = Array.isArray(schema?.tables) ? schema.tables.length : 0;
				const functions = Array.isArray(schema?.functions) ? schema.functions.length : 0;
				return Object.freeze({
					boxId: record.boxId,
					...(record.sectionInstanceId ? { sectionInstanceId: record.sectionInstanceId } : {}),
					targetGeneration: record.targetGeneration,
					hasConnection: !!record.target?.connectionId,
					hasDatabase: !!record.target?.database,
					hasDatabaseRequest: !!record.databaseRequestToken,
					hasSchemaRequest: !!record.schemaRequestToken,
					modelAttached: !!record.modelUri,
					modelGeneration: record.modelGeneration,
					catalog: Object.freeze({
						tables,
						functions,
						hasRawSchema: schema?.rawSchemaJson !== undefined,
					}),
					...(preparation ? {
						preparation: Object.freeze({
							status: String(preparation.status || ''),
							stage: String(preparation.stage || ''),
							...(typeof preparation.generation === 'number' ? { generation: preparation.generation } : {}),
							...(typeof preparation.revision === 'number' ? { revision: preparation.revision } : {}),
							blockers: Object.freeze(Array.isArray(preparation.blockers)
								? preparation.blockers.map(value => String(value))
								: []),
							usableFallback: preparation.usableFallback === true,
						}),
					} : {}),
					...(worker ? {
						worker: Object.freeze({
							status: String(worker.status || ''),
							hasSchemaKey: typeof worker.schemaKey === 'string' && worker.schemaKey.length > 0,
							hasSchemaSignature: typeof worker.schemaSignature === 'string' && worker.schemaSignature.length > 0,
							modelMatches: !!record.modelUri && worker.modelUri === record.modelUri,
							preparationMatches: worker.status === 'ready'
								&& typeof preparationTarget?.schemaKey === 'string'
								&& typeof preparationTarget?.modelUri === 'string'
								&& worker.schemaKey === preparationTarget.schemaKey
								&& worker.schemaSignature === preparationTarget.schemaSignature
								&& worker.modelUri === preparationTarget.modelUri,
						}),
					} : {}),
					...(pending ? {
						pending: Object.freeze({
							...(typeof pending.reason === 'string' ? { reason: pending.reason } : {}),
							backgroundOnly: pending.backgroundOnly === true,
						}),
					} : {}),
				});
			});
		return Object.freeze({ sections: Object.freeze(sections) });
	}

	subscribeOwnedState<T>(
		boxId: string,
		slot: KustoEditorOwnedStateSlot,
		listener: (value: T) => void,
	): () => void {
		const id = normalizeId(boxId);
		if (!id) return () => undefined;
		const record = this.getOrCreateRecord(id);
		if (!record) return () => undefined;
		let listeners = record.listeners.get(slot);
		if (!listeners) {
			listeners = new Set();
			record.listeners.set(slot, listeners);
		}
		const untypedListener = listener as (value: unknown) => void;
		listeners.add(untypedListener);
		return () => {
			const current = record.listeners.get(slot);
			current?.delete(untypedListener);
			if (current?.size === 0) record.listeners.delete(slot);
		};
	}

	publishOwnedState<T>(boxId: string, slot: KustoEditorOwnedStateSlot, value: T): void {
		const id = normalizeId(boxId);
		if (!id) return;
		const record = this.getOrCreateRecord(id);
		if (!record) return;
		if (value === undefined) delete record.ownedState[slot];
		else record.ownedState[slot] = value;
		this.publishOwnedStateListeners(record, slot, value);
	}

	private publishOwnedStateListeners(record: KustoEditorRecord, slot: KustoEditorOwnedStateSlot, value: unknown, isCurrent?: () => boolean): void {
		for (const listener of Array.from(record.listeners.get(slot) || [])) {
			if (isCurrent && !isCurrent()) break;
			listener(value);
		}
	}

	attachModel(lease: KustoEditorSectionLease, modelUri: string): KustoEditorModelLease | undefined {
		const current = this.getRecord(lease);
		const uri = normalizeId(modelUri);
		if (!current || !uri) return undefined;
		if (current.modelUri !== uri) {
			current.modelUri = uri;
			current.modelGeneration += 1;
		}
		return Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
			modelUri: uri,
			modelGeneration: current.modelGeneration,
		});
	}

	detachModel(lease: KustoEditorModelLease): boolean {
		const current = this.getRecord(lease);
		if (!current
			|| current.modelUri !== normalizeId(lease.modelUri)
			|| current.modelGeneration !== lease.modelGeneration) return false;
		current.modelUri = undefined;
		current.modelGeneration += 1;
		return true;
	}

	isSectionLeaseCurrent(lease: KustoEditorSectionLease): boolean {
		return !!this.getRecord(lease);
	}

	isModelLeaseCurrent(lease: KustoEditorModelLease): boolean {
		const current = this.getRecord(lease);
		return !!current
			&& current.modelUri === normalizeId(lease.modelUri)
			&& current.modelGeneration === lease.modelGeneration;
	}

	isCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		target?: KustoEditorSchemaTarget,
		requestToken?: string,
	): boolean {
		const current = this.getCurrentRecord(boxId, identity);
		if (!current) return false;
		if (target && (!current.target || !targetsEqual(current.target, normalizeTarget(target.connectionId, target.database, target)))) return false;
		const token = normalizeId(requestToken);
		return !token || current.schemaRequestToken === token;
	}

	isDatabaseRequestCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		connectionId: string,
		requestToken: string,
	): boolean {
		const current = this.getCurrentRecord(boxId, identity);
		return !!current
			&& current.target?.connectionId === normalizeId(connectionId)
			&& current.databaseRequestToken === normalizeId(requestToken);
	}

	isSchemaRequestCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		target: KustoEditorSchemaTarget,
		requestToken: string,
	): boolean {
		const current = this.getCurrentRecord(boxId, identity);
		return !!current
			&& !!current.target && logicalTargetsEqual(current.target, normalizeTarget(target.connectionId, target.database))
			&& current.schemaRequestToken === normalizeId(requestToken);
	}

	clear(): void {
		for (const record of this.editors.values()) this.retireRecord(record);
		this.editors.clear();
		this.tombstonedBoxIds.clear();
	}

	private getCurrentRecord(boxId: string, identity: KustoEditorLifecycleIdentity): KustoEditorRecord | undefined {
		const current = this.editors.get(normalizeId(boxId));
		return current
			&& current.sectionInstanceId === normalizeId(identity.sectionInstanceId)
			&& current.targetGeneration === identity.targetGeneration
			? current : undefined;
	}

	private getRecord(lease: KustoEditorSectionLease): ActiveKustoEditorRecord | undefined {
		const current = this.editors.get(normalizeId(lease.boxId));
		return current?.sectionInstanceId === normalizeId(lease.sectionInstanceId)
			? current as ActiveKustoEditorRecord
			: undefined;
	}

	private getOrCreateRecord(boxId: string): KustoEditorRecord | undefined {
		let current = this.editors.get(boxId);
		if (!current && this.tombstonedBoxIds.has(boxId)) return undefined;
		if (!current) {
			current = {
				boxId,
				targetGeneration: 0,
				modelGeneration: 0,
				ownedState: {},
				listeners: new Map(),
			};
			this.editors.set(boxId, current);
		}
		return current;
	}

	private asRecord(value: unknown): Record<string, unknown> | undefined {
		return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
	}

	private retireRecord(record: KustoEditorRecord): void {
		this.settleWorkerWaiters(record.ownedState.workerReadyWaiters);
		this.revokeWorkerReady(record);
		for (const key of Object.keys(record.ownedState) as KustoEditorOwnedStateSlot[]) {
			delete record.ownedState[key];
		}
		record.listeners.clear();
	}

	private retireTargetState(record: KustoEditorRecord, notify = true): void {
		if (notify) this.settleWorkerWaiters(record.ownedState.workerReadyWaiters);
		for (const slot of [
			'schema',
			'schemaMeta',
			'pendingWorkerUpdate',
			'workerReady',
			'enhancementReady',
			'workerApplyRequired',
			'workerReadyWaiters',
		] satisfies KustoEditorOwnedStateSlot[]) {
			if (slot === 'workerReady' && notify) {
				this.revokeWorkerReady(record);
				continue;
			}
			delete record.ownedState[slot];
		}
		record.targetGeneration += 1;
		record.databaseRequestToken = undefined;
		record.schemaRequestToken = undefined;
	}

	private revokeWorkerReady(record: KustoEditorRecord): void {
		if (!('workerReady' in record.ownedState)) return;
		delete record.ownedState.workerReady;
		this.publishOwnedStateListeners(record, 'workerReady', undefined);
	}

	private settleWorkerWaiters(waiters: unknown): void {
		if (Array.isArray(waiters)) {
			for (const waiter of waiters) {
				try {
					if (waiter && typeof waiter === 'object' && typeof waiter.resolve === 'function') {
						waiter.resolve(false);
					}
				} catch (error) {
					console.error('[kusto]', error);
				}
			}
		}
	}
}