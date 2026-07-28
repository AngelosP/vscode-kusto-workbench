import type { QueryResult } from './kustoClient.js';
import type { QueryRunCoordinator } from './queryRunCoordinator.js';
import type {
	KustoDispatchIdentity,
	KustoExecutionRequestIdentity,
	KustoExecutionReservation,
	KustoExecutionSuccessStamp,
	KustoExecutionTerminalStamp,
	KustoSectionLifecycleOwner,
} from '../shared/kustoExecution.js';
import { kustoExecutionIdentityEquals, kustoExecutionRequestIdentityEquals } from '../shared/kustoExecution.js';

type KustoCancelableExecution = Readonly<{
	cancel: () => void;
	promise: Promise<QueryResult>;
}>;
 
type KustoPhysicalConnectionOwner = Readonly<{
	connectionRevision: number;
	connectionIdentityKey: string;
}>;

type ActiveExecution = {
	readonly reservation: KustoExecutionReservation;
	readonly preflightCancel: () => void;
	readonly runSeq: number;
	readonly physicalOwner?: KustoPhysicalConnectionOwner;
	transportCancel?: () => void;
	dispatch?: KustoDispatchIdentity;
};

export type KustoExecutionLease<T extends KustoCancelableExecution = KustoCancelableExecution> = Readonly<{
	reservation: KustoExecutionReservation;
	execution: T;
	isCurrent: () => boolean;
	captureDispatch: (identity: KustoDispatchIdentity) => boolean;
	getDispatch: () => KustoDispatchIdentity | undefined;
	release: () => void;
}>;

export type KustoExecutionTerminal =
	| (KustoExecutionSuccessStamp & Readonly<{ type: 'queryResult'; result: QueryResult; ensureResultsVisible?: boolean }>)
	| (KustoExecutionTerminalStamp & Readonly<{ type: 'queryError'; error: string; clientActivityId?: string }>)
	| (KustoExecutionTerminalStamp & Readonly<{ type: 'queryCancelled'; reason?: 'cancelled' | 'superseded' | 'retired' }>);

export interface KustoExecutionCoordinatorOptions {
	queryRuns: QueryRunCoordinator;
	postMessage: (message: KustoExecutionTerminal) => boolean | PromiseLike<boolean>;
	getCurrentConnectionOwner?: (connectionId: string) => KustoPhysicalConnectionOwner | undefined;
}

function normalize(value: unknown): string {
	return String(value || '').trim();
}

function sameTarget(left: KustoSectionLifecycleOwner, right: KustoExecutionRequestIdentity): boolean {
	return left.sectionInstanceId === right.sectionInstanceId
		&& left.targetGeneration === right.targetGeneration
		&& normalize(left.connectionId) === right.connectionId
		&& normalize(left.database).toLowerCase() === right.database.toLowerCase();
}

function physicalOwnerFromLifecycle(owner: KustoSectionLifecycleOwner): KustoPhysicalConnectionOwner | undefined {
	return Number.isSafeInteger(owner.connectionRevision) && Number(owner.connectionRevision) >= 0
		&& !!normalize(owner.connectionIdentityKey)
		? Object.freeze({
			connectionRevision: Number(owner.connectionRevision),
			connectionIdentityKey: normalize(owner.connectionIdentityKey),
		})
		: undefined;
}

function samePhysicalOwner(left: KustoPhysicalConnectionOwner | undefined, right: KustoPhysicalConnectionOwner | undefined): boolean {
	return !!left && !!right
		&& left.connectionRevision === right.connectionRevision
		&& left.connectionIdentityKey === right.connectionIdentityKey;
}

export class KustoExecutionCoordinator {
	private readonly lifecycleByBoxId = new Map<string, KustoSectionLifecycleOwner>();
	private readonly closedSectionInstances = new Set<string>();
	private readonly activeByBoxId = new Map<string, ActiveExecution>();
	private reservationSequence = 0;
	private disposed = false;

	constructor(private readonly options: KustoExecutionCoordinatorOptions) {}

	openSection(boxId: string, sectionInstanceId: string): boolean {
		if (this.disposed) return false;
		const id = normalize(boxId);
		const instanceId = normalize(sectionInstanceId);
		if (!id || !instanceId || this.closedSectionInstances.has(instanceId)) return false;
		const current = this.lifecycleByBoxId.get(id);
		if (current?.sectionInstanceId === instanceId) return true;
		if (current) this.retireBox(id, 'retired');
		this.lifecycleByBoxId.set(id, Object.freeze({
			boxId: id,
			sectionInstanceId: instanceId,
			targetGeneration: 0,
		}));
		return true;
	}

	adoptTarget(owner: KustoSectionLifecycleOwner): boolean {
		if (this.disposed) return false;
		const boxId = normalize(owner.boxId);
		const sectionInstanceId = normalize(owner.sectionInstanceId);
		const connectionId = normalize(owner.connectionId);
		const database = normalize(owner.database);
		if (!boxId || !sectionInstanceId || !Number.isSafeInteger(owner.targetGeneration)
			|| owner.targetGeneration < 0 || this.closedSectionInstances.has(sectionInstanceId)) return false;
		const current = this.lifecycleByBoxId.get(boxId);
		if (!current || current.sectionInstanceId !== sectionInstanceId) return false;
		const physicalOwner = connectionId ? physicalOwnerFromLifecycle(owner) : undefined;
		if (this.options.getCurrentConnectionOwner && connectionId
			&& !samePhysicalOwner(physicalOwner, this.options.getCurrentConnectionOwner(connectionId))) return false;
		if (owner.targetGeneration < current.targetGeneration) return false;
		if (owner.targetGeneration === current.targetGeneration) {
			return normalize(current.connectionId) === connectionId
				&& normalize(current.database).toLowerCase() === database.toLowerCase()
				&& (!this.options.getCurrentConnectionOwner || !connectionId
					|| samePhysicalOwner(physicalOwnerFromLifecycle(current), physicalOwner));
		}
		this.retireBox(boxId, 'retired');
		this.lifecycleByBoxId.set(boxId, Object.freeze({
			boxId,
			sectionInstanceId,
			targetGeneration: owner.targetGeneration,
			...(connectionId ? { connectionId } : {}),
			...(database ? { database } : {}),
			...(physicalOwner || {}),
		}));
		return true;
	}

	closeSection(boxId: string, sectionInstanceId: string): boolean {
		const id = normalize(boxId);
		const instanceId = normalize(sectionInstanceId);
		const current = this.lifecycleByBoxId.get(id);
		if (!current || current.sectionInstanceId !== instanceId) return false;
		this.lifecycleByBoxId.delete(id);
		this.closedSectionInstances.add(instanceId);
		this.retireBox(id, 'retired');
		return true;
	}

	reserve(request: KustoExecutionRequestIdentity): KustoExecutionReservation {
		if (this.disposed) throw new Error('Kusto execution coordinator is disposed.');
		const boxId = normalize(request.boxId);
		const executionId = normalize(request.executionId);
		const connectionId = normalize(request.connectionId);
		const database = normalize(request.database);
		if (!boxId || !executionId || !connectionId || !database) {
			throw new Error('Kusto execution identity is incomplete.');
		}
		const lifecycle = this.lifecycleByBoxId.get(boxId);
		if (!lifecycle || !sameTarget(lifecycle, request)) {
			throw new Error('Kusto execution target is no longer current.');
		}
		const physicalOwner = physicalOwnerFromLifecycle(lifecycle);
		if (this.options.getCurrentConnectionOwner
			&& !samePhysicalOwner(physicalOwner, this.options.getCurrentConnectionOwner(connectionId))) {
			throw new Error('Kusto physical connection target is no longer current.');
		}
		const current = this.activeByBoxId.get(boxId);
		if (current && kustoExecutionRequestIdentityEquals(current.reservation, request)) {
			throw new Error('Kusto execution identity is already reserved.');
		}
		const reservation = Object.freeze({
			...request,
			boxId,
			executionId,
			connectionId,
			database,
			reservationSequence: ++this.reservationSequence,
		});
		const runSeq = this.options.queryRuns.nextSequence();
		const preflightCancel = () => undefined;
		const active: ActiveExecution = { reservation, preflightCancel, runSeq, ...(physicalOwner ? { physicalOwner } : {}) };
		const retired = this.activeByBoxId.get(boxId);
		this.activeByBoxId.set(boxId, active);
		const previousRun = this.options.queryRuns.replaceAndCancel(boxId, {
			cancel: preflightCancel,
			runSeq,
			executionId,
		});
		if (retired) this.publishCancellation(retired, 'superseded');
		else if (previousRun?.executionId && previousRun.executionId !== executionId) {
			// A non-Kusto owner may share the low-level registry. It owns its own terminal.
		}
		return reservation;
	}

	async rejectPreclaimedRequest(request: KustoExecutionRequestIdentity): Promise<boolean> {
		const terminal = Object.freeze({
			...request,
			boxId: normalize(request.boxId),
			executionId: normalize(request.executionId),
			connectionId: normalize(request.connectionId),
			database: normalize(request.database),
			reservationSequence: ++this.reservationSequence,
			type: 'queryCancelled' as const,
			reason: 'retired' as const,
		});
		if (await this.deliver(terminal)) return true;
		return this.deliver(terminal);
	}

	hasExactActiveRequest(request: KustoExecutionRequestIdentity): boolean {
		const active = this.activeByBoxId.get(normalize(request.boxId));
		return !!active && kustoExecutionRequestIdentityEquals(active.reservation, request);
	}

	start<T extends KustoCancelableExecution>(reservation: KustoExecutionReservation, start: () => T): KustoExecutionLease<T> {
		const active = this.requireActive(reservation);
		if (this.options.getCurrentConnectionOwner
			&& !samePhysicalOwner(active.physicalOwner, this.options.getCurrentConnectionOwner(reservation.connectionId))) {
			this.retireActive(active, 'retired');
			throw new Error('Kusto physical connection target changed before dispatch.');
		}
		let execution: T;
		try {
			execution = start();
		} catch (error) { throw error; }
		if (!this.isActiveRecord(active)) {
			void execution.promise.catch(() => undefined);
			try { execution.cancel(); } catch { /* best effort */ }
			throw new Error('Kusto execution was superseded before dispatch.');
		}
		if (!this.options.queryRuns.replaceIfCurrent(active.reservation.boxId, active.preflightCancel, active.runSeq, {
			cancel: execution.cancel,
			runSeq: active.runSeq,
			executionId: active.reservation.executionId,
		})) {
			void execution.promise.catch(() => undefined);
			try { execution.cancel(); } catch { /* best effort */ }
			this.releaseReservation(reservation, active);
			throw new Error('Kusto execution was superseded before transport promotion.');
		}
		active.transportCancel = execution.cancel;
		let released = false;
		return Object.freeze({
			reservation,
			execution,
			isCurrent: () => this.isActiveRecord(active),
			captureDispatch: identity => {
				if (!this.isActiveRecord(active)) return false;
				const dispatchOwner = Object.freeze({
					connectionRevision: identity.connectionRevision,
					connectionIdentityKey: identity.connectionIdentityKey,
				});
				if ((active.physicalOwner && !samePhysicalOwner(active.physicalOwner, dispatchOwner))
					|| (this.options.getCurrentConnectionOwner
						&& !samePhysicalOwner(active.physicalOwner, this.options.getCurrentConnectionOwner(reservation.connectionId)))) {
					this.retireActive(active, 'retired');
					return false;
				}
				active.dispatch = Object.freeze({ ...identity });
				return true;
			},
			getDispatch: () => active.dispatch,
			release: () => {
				if (released) return;
				released = true;
				this.options.queryRuns.unregister(reservation.boxId, execution.cancel, active.runSeq);
			},
		});
	}

	async succeed(reservation: KustoExecutionReservation, result: QueryResult, ensureResultsVisible = false): Promise<boolean> {
		const active = this.activeByBoxId.get(reservation.boxId);
		if (!active || !kustoExecutionRequestIdentityEquals(active.reservation, reservation)
			|| active.reservation.reservationSequence !== reservation.reservationSequence) return false;
		if (!active.dispatch) {
			this.retireActive(active, 'retired');
			return false;
		}
		const lifecycle = this.lifecycleByBoxId.get(reservation.boxId);
		if (!lifecycle || !sameTarget(lifecycle, reservation)) {
			this.retireActive(active, 'retired');
			return false;
		}
		const terminal = {
			...this.terminalStamp(active),
			dispatch: active.dispatch!,
			type: 'queryResult' as const,
			result,
			...(ensureResultsVisible ? { ensureResultsVisible: true } : {}),
		};
		if (!this.finishActive(active)) return false;
		const delivered = await this.deliver({
			...terminal,
		});
		if (delivered) return true;
		await this.deliver({
			...this.terminalStamp(active),
			type: 'queryCancelled',
			reason: 'retired',
		});
		return false;
	}

	fail(reservation: KustoExecutionReservation, error: string, clientActivityId?: string): boolean {
		return this.settle(reservation, stamp => ({
			...stamp,
			type: 'queryError',
			error,
			...(clientActivityId ? { clientActivityId } : {}),
		}));
	}

	cancelExpected(identity: Pick<KustoExecutionRequestIdentity, 'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>): boolean {
		const active = this.activeByBoxId.get(normalize(identity.boxId));
		if (!active || !kustoExecutionIdentityEquals(active.reservation, identity)) return false;
		this.retireActive(active, 'cancelled');
		return true;
	}

	revokeConnections(connectionIds: readonly string[], preserveAccountPartition?: string): void {
		const ids = new Set(connectionIds.map(normalize).filter(Boolean));
		for (const active of [...this.activeByBoxId.values()]) {
			if (ids.size > 0 && !ids.has(active.reservation.connectionId)) continue;
			if (preserveAccountPartition && active.dispatch?.accountPartition === preserveAccountPartition) continue;
			this.retireActive(active, 'retired');
		}
	}

	invalidatePhysicalConnections(connectionIds: readonly string[]): void {
		const ids = new Set(connectionIds.map(normalize).filter(Boolean));
		for (const [boxId, owner] of [...this.lifecycleByBoxId]) {
			if (!owner.connectionId || !ids.has(owner.connectionId)) continue;
			this.retireBox(boxId, 'retired');
			this.lifecycleByBoxId.set(boxId, Object.freeze({
				boxId: owner.boxId,
				sectionInstanceId: owner.sectionInstanceId,
				targetGeneration: owner.targetGeneration,
				connectionId: owner.connectionId,
				...(owner.database ? { database: owner.database } : {}),
			}));
		}
	}

	getActive(boxId: string): KustoExecutionReservation | undefined {
		return this.activeByBoxId.get(normalize(boxId))?.reservation;
	}

	getDispatchAccountPartition(identity: Pick<KustoExecutionRequestIdentity, 'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>): string | undefined {
		const active = this.activeByBoxId.get(normalize(identity.boxId));
		return active && kustoExecutionIdentityEquals(active.reservation, identity)
			? active.dispatch?.accountPartition
			: undefined;
	}

	getTarget(boxId: string): KustoSectionLifecycleOwner | undefined {
		return this.lifecycleByBoxId.get(normalize(boxId));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const active of [...this.activeByBoxId.values()]) this.retireActive(active, 'retired');
		this.lifecycleByBoxId.clear();
		this.closedSectionInstances.clear();
	}

	private settle(
		reservation: KustoExecutionReservation,
		createTerminal: (stamp: KustoExecutionTerminalStamp) => KustoExecutionTerminal,
	): boolean {
		const active = this.activeByBoxId.get(reservation.boxId);
		if (!active || !kustoExecutionRequestIdentityEquals(active.reservation, reservation)
			|| active.reservation.reservationSequence !== reservation.reservationSequence) return false;
		const lifecycle = this.lifecycleByBoxId.get(reservation.boxId);
		if (!lifecycle || !sameTarget(lifecycle, reservation)) {
			this.retireActive(active, 'retired');
			return false;
		}
		this.activeByBoxId.delete(reservation.boxId);
		if (active.transportCancel) this.options.queryRuns.unregister(reservation.boxId, active.transportCancel, active.runSeq);
		else this.options.queryRuns.unregister(reservation.boxId, active.preflightCancel, active.runSeq);
		const stamp = this.terminalStamp(active);
		this.queueTerminalDelivery(active, createTerminal(stamp));
		return true;
	}

	private requireActive(reservation: KustoExecutionReservation): ActiveExecution {
		const active = this.activeByBoxId.get(reservation.boxId);
		if (!active || !kustoExecutionRequestIdentityEquals(active.reservation, reservation)
			|| active.reservation.reservationSequence !== reservation.reservationSequence) {
			throw new Error('Kusto execution reservation is no longer current.');
		}
		return active;
	}

	private isActiveRecord(active: ActiveExecution): boolean {
		return this.activeByBoxId.get(active.reservation.boxId) === active;
	}

	private releaseReservation(reservation: KustoExecutionReservation, active: ActiveExecution): void {
		if (this.activeByBoxId.get(reservation.boxId) === active) this.activeByBoxId.delete(reservation.boxId);
		this.options.queryRuns.unregister(reservation.boxId, active.preflightCancel, active.runSeq);
	}

	private finishActive(active: ActiveExecution): boolean {
		if (!this.isActiveRecord(active)) return false;
		this.activeByBoxId.delete(active.reservation.boxId);
		if (active.transportCancel) this.options.queryRuns.unregister(active.reservation.boxId, active.transportCancel, active.runSeq);
		else this.options.queryRuns.unregister(active.reservation.boxId, active.preflightCancel, active.runSeq);
		return true;
	}

	private retireBox(boxId: string, reason: 'superseded' | 'retired'): void {
		const active = this.activeByBoxId.get(boxId);
		if (active) this.retireActive(active, reason);
	}

	private retireActive(active: ActiveExecution, reason: 'cancelled' | 'superseded' | 'retired'): void {
		if (!this.isActiveRecord(active)) return;
		this.activeByBoxId.delete(active.reservation.boxId);
		const running = this.options.queryRuns.get(active.reservation.boxId);
		if (running?.runSeq === active.runSeq) this.options.queryRuns.cancel(active.reservation.boxId);
		this.publishCancellation(active, reason);
	}

	private publishCancellation(active: ActiveExecution, reason: 'cancelled' | 'superseded' | 'retired'): void {
		this.queueTerminalDelivery(active, {
			...this.terminalStamp(active),
			type: 'queryCancelled',
			reason,
		});
	}

	private queueTerminalDelivery(active: ActiveExecution, terminal: KustoExecutionTerminal): void {
		void (async () => {
			if (await this.deliver(terminal)) return;
			await this.deliver({
				...this.terminalStamp(active),
				type: 'queryCancelled',
				reason: 'retired',
			});
		})();
	}

	private terminalStamp(active: ActiveExecution): KustoExecutionTerminalStamp {
		return Object.freeze({
			...active.reservation,
			...(active.dispatch ? { dispatch: active.dispatch } : {}),
		});
	}

	private async deliver(message: KustoExecutionTerminal): Promise<boolean> {
		try {
			return await Promise.resolve(this.options.postMessage(message)) === true;
		} catch {
			return false;
		}
	}
}