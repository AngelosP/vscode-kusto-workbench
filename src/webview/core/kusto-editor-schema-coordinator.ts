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

function targetsEqual(
	left: KustoEditorSchemaTarget | undefined,
	right: KustoEditorSchemaTarget | undefined,
): boolean {
	return left?.connectionId === right?.connectionId
		&& normalizeId(left?.database).toLowerCase() === normalizeId(right?.database).toLowerCase();
}

export class KustoEditorSchemaCoordinator {
	private readonly editors = new Map<string, KustoEditorRecord>();
	private readonly tombstonedBoxIds = new Set<string>();

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
		return Object.freeze({ boxId: id, sectionInstanceId: instanceId });
	}

	closeSection(lease: KustoEditorSectionLease): boolean {
		const current = this.getRecord(lease);
		if (!current) return false;
		this.retireRecord(current);
		this.editors.delete(current.boxId);
		this.tombstonedBoxIds.add(current.boxId);
		return true;
	}

	setTarget(
		lease: KustoEditorSectionLease,
		connectionId: string,
		database?: string,
	): KustoEditorLifecycleIdentity | undefined {
		const current = this.getRecord(lease);
		if (!current) return undefined;
		const normalizedConnectionId = normalizeId(connectionId);
		const normalizedDatabase = normalizeId(database);
		const target = normalizedConnectionId
			? Object.freeze({
				connectionId: normalizedConnectionId,
				...(normalizedDatabase ? { database: normalizedDatabase } : {}),
			})
			: undefined;
		if (!targetsEqual(current.target, target)) {
			this.retireTargetState(current);
			current.targetGeneration += 1;
			current.target = target;
			current.databaseRequestToken = undefined;
			current.schemaRequestToken = undefined;
		}
		return this.getIdentity(current.boxId);
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
		current.targetGeneration += 1;
		current.databaseRequestToken = undefined;
		current.schemaRequestToken = undefined;
		return this.getIdentity(current.boxId);
	}

	beginSchemaRequest(
		lease: KustoEditorSectionLease,
		requestToken: string,
	): KustoEditorSchemaRequestIdentity | undefined {
		const current = this.getRecord(lease);
		const token = normalizeId(requestToken);
		if (!current?.target?.connectionId || !current.target.database || !token) return undefined;
		current.schemaRequestToken = token;
		return Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
			targetGeneration: current.targetGeneration,
			requestToken: token,
		});
	}

	beginDatabaseRequest(
		lease: KustoEditorSectionLease,
		requestToken: string,
	): KustoEditorSchemaRequestIdentity | undefined {
		const current = this.getRecord(lease);
		const token = normalizeId(requestToken);
		if (!current?.target?.connectionId || !token) return undefined;
		current.databaseRequestToken = token;
		return Object.freeze({
			boxId: current.boxId,
			sectionInstanceId: current.sectionInstanceId,
			targetGeneration: current.targetGeneration,
			requestToken: token,
		});
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
			if (slot === 'workerReadyWaiters') this.settleWorkerWaiters(record);
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
		record.ownedState[slot] = value;
		for (const listener of Array.from(record.listeners.get(slot) || [])) {
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
		const current = this.editors.get(normalizeId(lease.boxId));
		if (!current
			|| current.sectionInstanceId !== normalizeId(lease.sectionInstanceId)
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
		const current = this.editors.get(normalizeId(lease.boxId));
		return !!current
			&& current.sectionInstanceId === normalizeId(lease.sectionInstanceId)
			&& current.modelUri === normalizeId(lease.modelUri)
			&& current.modelGeneration === lease.modelGeneration;
	}

	isCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		target?: KustoEditorSchemaTarget,
		requestToken?: string,
	): boolean {
		const current = this.editors.get(normalizeId(boxId));
		if (!current
			|| current.sectionInstanceId !== normalizeId(identity.sectionInstanceId)
			|| current.targetGeneration !== identity.targetGeneration) return false;
		if (target && !targetsEqual(current.target, {
			connectionId: normalizeId(target.connectionId),
			...(normalizeId(target.database) ? { database: normalizeId(target.database) } : {}),
		})) return false;
		const token = normalizeId(requestToken);
		return !token || current.schemaRequestToken === token;
	}

	isDatabaseRequestCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		connectionId: string,
		requestToken: string,
	): boolean {
		const current = this.editors.get(normalizeId(boxId));
		return !!current
			&& current.sectionInstanceId === normalizeId(identity.sectionInstanceId)
			&& current.targetGeneration === identity.targetGeneration
			&& current.target?.connectionId === normalizeId(connectionId)
			&& current.databaseRequestToken === normalizeId(requestToken);
	}

	isSchemaRequestCurrent(
		boxId: string,
		identity: KustoEditorLifecycleIdentity,
		target: KustoEditorSchemaTarget,
		requestToken: string,
	): boolean {
		const current = this.editors.get(normalizeId(boxId));
		return !!current
			&& current.sectionInstanceId === normalizeId(identity.sectionInstanceId)
			&& current.targetGeneration === identity.targetGeneration
			&& targetsEqual(current.target, {
				connectionId: normalizeId(target.connectionId),
				...(normalizeId(target.database) ? { database: normalizeId(target.database) } : {}),
			})
			&& current.schemaRequestToken === normalizeId(requestToken);
	}

	clear(): void {
		for (const record of this.editors.values()) this.retireRecord(record);
		this.editors.clear();
		this.tombstonedBoxIds.clear();
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
		this.settleWorkerWaiters(record);
		for (const key of Object.keys(record.ownedState) as KustoEditorOwnedStateSlot[]) {
			delete record.ownedState[key];
		}
		record.listeners.clear();
	}

	private retireTargetState(record: KustoEditorRecord): void {
		this.settleWorkerWaiters(record);
		for (const slot of [
			'schema',
			'schemaMeta',
			'pendingWorkerUpdate',
			'workerReady',
			'enhancementReady',
			'workerApplyRequired',
			'workerReadyWaiters',
		] satisfies KustoEditorOwnedStateSlot[]) {
			delete record.ownedState[slot];
		}
	}

	private settleWorkerWaiters(record: KustoEditorRecord): void {
		const waiters = record.ownedState.workerReadyWaiters;
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