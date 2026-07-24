import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { SqlStsRequestCoordinator, type SqlStsRequestOwner } from '../monaco/sql-sts-request-coordinator.js';
import {
	registerSqlSectionSession,
	unregisterSqlSectionSession,
	type SqlSectionSessionTarget,
} from '../core/sql-section-message-router.js';

const SQL_TERMINAL_TYPES = new Set(['queryResult', 'queryError', 'queryCancelled']);

export type SqlToolExpectedOwner = Readonly<{
	connectionId: string;
	database: string;
	targetSignature: string;
	principalFingerprint: string;
	revocationGeneration: number;
}>;

export type SqlToolExecutionOwner = Readonly<{
	connectionId: string;
	database: string;
	ownerToken: string;
	generation: number;
}>;

export type SqlToolRunResult = Readonly<{
	rowCount: number;
	executionId: string;
	owner: SqlToolExecutionOwner;
}>;

export interface SqlSectionLifecycleEffects {
	isRestoreInProgress(): boolean;
	clearSchema(boxId: string): void;
	setSchemaStatus(info: { status: 'not-loaded' | 'loading'; statusText: string }): void;
	setDatabases(databases: string[], desiredDatabase?: string): void;
	setDatabasesLoading(loading: boolean): void;
	setRefreshLoading(loading: boolean): void;
	getConnectionId(boxId: string): string;
	getDatabase(boxId: string): string;
	postMessage(message: Record<string, unknown>): void;
	persist(): void;
}

export interface SqlConnectionChangedDetail {
	boxId?: string;
	connectionId?: string;
	database?: string;
	preserveTargetGeneration?: boolean;
	suppressMetadataRefresh?: boolean;
}

export interface SqlDatabaseChangedDetail {
	boxId?: string;
	database?: string;
	preserveTargetGeneration?: boolean;
	suppressMetadataRefresh?: boolean;
}

type PendingToolRun = {
	executionId: string;
	query?: string;
	owner?: SqlToolExecutionOwner;
	resolve: (result: SqlToolRunResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	terminalTimeoutMs: number;
};

export class SqlSectionSessionController implements ReactiveController, SqlSectionSessionTarget {
	readonly instanceId = globalThis.crypto?.randomUUID?.()
		?? `sql-instance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	private registeredBoxId = '';
	private databaseRequestId = '';
	private _targetGeneration = 0;
	private _ownerToken = '';
	private _stsReady = false;
	private _stsDocumentOpened = false;
	private _stsConnectTarget = '';
	private _stsConnectPending = false;
	private activeExecutionId = '';
	private readonly cancelledExecutionIds: string[] = [];
	private readonly stsRequests = new SqlStsRequestCoordinator();
	private pendingToolRun: PendingToolRun | undefined;
	private _toolExpectedOwner: SqlToolExpectedOwner | undefined;
	private lifecycleEffects: SqlSectionLifecycleEffects | undefined;
	private onToolRunTimeout: ((executionId: string) => void) | undefined;

	constructor(private readonly host: ReactiveControllerHost) {
		host.addController(this);
	}

	get boxId(): string { return this.registeredBoxId; }
	get targetGeneration(): number { return this._targetGeneration; }
	get ownerToken(): string { return this._ownerToken; }
	get stsReady(): boolean { return this._stsReady; }
	get stsDocumentOpened(): boolean { return this._stsDocumentOpened; }
	get stsConnectTarget(): string { return this._stsConnectTarget; }
	get stsConnectPending(): boolean { return this._stsConnectPending; }
	get currentExecutionId(): string { return this.activeExecutionId; }
	get hasPendingToolRun(): boolean { return !!this.pendingToolRun; }
	get pendingToolExecutionId(): string { return this.pendingToolRun?.executionId ?? ''; }
	get toolExpectedOwner(): SqlToolExpectedOwner | undefined { return this._toolExpectedOwner; }

	hostConnected(): void {}
	hostDisconnected(): void {
		queueMicrotask(() => {
			if ((this.host as unknown as { isConnected?: boolean }).isConnected) return;
			this.clear();
			this.detach();
		});
	}

	attach(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id || this.registeredBoxId === id) return;
		this.detach();
		this.registeredBoxId = id;
		registerSqlSectionSession(this);
	}

	detach(): void {
		if (!this.registeredBoxId) return;
		unregisterSqlSectionSession(this.registeredBoxId, this);
		this.stsRequests.clearBox(this.registeredBoxId);
		this.registeredBoxId = '';
	}

	configureLifecycleEffects(effects: SqlSectionLifecycleEffects): void {
		this.lifecycleEffects = effects;
	}

	configureToolRunTimeout(onTimeout: (executionId: string) => void): void {
		this.onToolRunTimeout = onTimeout;
	}

	handleConnectionChanged(detail: SqlConnectionChangedDetail): void {
		const effects = this.lifecycleEffects;
		if (!effects) return;
		const boxId = String(detail.boxId || this.registeredBoxId || '').trim();
		const connectionId = String(detail.connectionId || '').trim();
		const targetGeneration = this.advanceTargetGeneration(detail.preserveTargetGeneration === true);
		effects.clearSchema(boxId);
		effects.setSchemaStatus({ status: 'not-loaded', statusText: 'Not loaded' });

		if (!effects.isRestoreInProgress()) {
			effects.postMessage({
				type: 'saveSqlLastSelection',
				sqlConnectionId: connectionId,
				database: '',
			});
			if (!connectionId) {
				effects.postMessage({
					type: 'retireSqlTarget',
					boxId,
					sectionInstanceId: this.instanceId,
					targetGeneration,
				});
			}
		}

		if (connectionId && !detail.suppressMetadataRefresh) {
			if (effects.isRestoreInProgress()) {
				const restoredDatabase = String(detail.database || '').trim();
				if (restoredDatabase) effects.setDatabases([restoredDatabase], restoredDatabase);
				return;
			}
			effects.setDatabasesLoading(true);
			effects.postMessage({
				type: 'getSqlDatabases',
				sqlConnectionId: connectionId,
				boxId,
				sectionInstanceId: this.instanceId,
				targetGeneration,
			});
		}
		effects.persist();
	}

	handleDatabaseChanged(detail: SqlDatabaseChangedDetail): void {
		const effects = this.lifecycleEffects;
		if (!effects) return;
		const boxId = String(detail.boxId || this.registeredBoxId || '').trim();
		const database = String(detail.database || '');
		const targetGeneration = this.advanceTargetGeneration(detail.preserveTargetGeneration === true);
		effects.clearSchema(boxId);

		if (!effects.isRestoreInProgress() && !detail.suppressMetadataRefresh) {
			const connectionId = effects.getConnectionId(boxId);
			if (connectionId) {
				effects.postMessage({
					type: 'saveSqlLastSelection',
					sqlConnectionId: connectionId,
					database,
				});
			}
			if (!database) {
				effects.postMessage({
					type: 'retireSqlTarget',
					boxId,
					sectionInstanceId: this.instanceId,
					targetGeneration,
				});
			}
			if (connectionId && database) {
				effects.setSchemaStatus({ status: 'loading', statusText: 'Loading…' });
				effects.postMessage({
					type: 'prefetchSqlSchema',
					sqlConnectionId: connectionId,
					database,
					boxId,
					sectionInstanceId: this.instanceId,
					targetGeneration,
				});
			}
		}
		effects.persist();
	}

	handleRefreshDatabases(detail: { boxId?: string; connectionId?: string }): void {
		const effects = this.lifecycleEffects;
		if (!effects) return;
		const boxId = String(detail.boxId || this.registeredBoxId || '').trim();
		const connectionId = String(detail.connectionId || '').trim();
		if (!connectionId) return;
		effects.setRefreshLoading(true);
		effects.postMessage({
			type: 'refreshSqlDatabases',
			sqlConnectionId: connectionId,
			boxId,
			sectionInstanceId: this.instanceId,
			targetGeneration: this._targetGeneration,
		});
	}

	handleSchemaRefresh(detail: { boxId?: string }): void {
		const effects = this.lifecycleEffects;
		if (!effects) return;
		const boxId = String(detail.boxId || this.registeredBoxId || '').trim();
		const connectionId = effects.getConnectionId(boxId);
		const database = effects.getDatabase(boxId);
		if (!connectionId || !database) return;
		effects.clearSchema(boxId);
		effects.setSchemaStatus({ status: 'loading', statusText: 'Refreshing…' });
		effects.postMessage({
			type: 'prefetchSqlSchema',
			sqlConnectionId: connectionId,
			database,
			boxId,
			sectionInstanceId: this.instanceId,
			targetGeneration: this._targetGeneration,
			forceRefresh: true,
		});
	}

	advanceTargetGeneration(preserve = false): number {
		if (!preserve) this._targetGeneration += 1;
		this.clearDatabaseRequest();
		return this._targetGeneration;
	}

	adoptHostGeneration(generation: number): boolean {
		if (!Number.isSafeInteger(generation) || generation < this._targetGeneration) return false;
		this._targetGeneration = generation;
		this.clearDatabaseRequest();
		return true;
	}

	clearDatabaseRequest(): void {
		this.databaseRequestId = '';
	}

	beginDatabaseRequest(requestId: string, generation: number): boolean {
		const id = String(requestId || '');
		if (!id || generation !== this._targetGeneration) return false;
		this.databaseRequestId = id;
		return true;
	}

	acceptDatabaseResponse(requestId: string | undefined, generation: number): boolean {
		const id = String(requestId || '');
		return !!id && generation === this._targetGeneration && this.databaseRequestId === id;
	}

	completeDatabaseRequest(requestId: string): boolean {
		if (!requestId || this.databaseRequestId !== requestId) return false;
		this.databaseRequestId = '';
		return true;
	}

	setStsReady(ready: boolean, ownerToken = '', targetGeneration?: number): boolean {
		if (targetGeneration !== undefined && targetGeneration !== this._targetGeneration) return false;
		this._stsReady = ready;
		this._ownerToken = ready ? String(ownerToken || '') : '';
		this._stsConnectPending = false;
		if (!ready) this._stsConnectTarget = '';
		const owner = ready && this._ownerToken
			? { ownerToken: this._ownerToken, targetGeneration: this._targetGeneration }
			: undefined;
		if (this.registeredBoxId) this.stsRequests.setOwner(this.registeredBoxId, owner);
		this.host.requestUpdate();
		return true;
	}

	setExecutionOwner(ownerToken: string, targetGeneration?: number): boolean {
		if (targetGeneration !== undefined && targetGeneration !== this._targetGeneration) return false;
		this._stsReady = false;
		this._ownerToken = String(ownerToken || '');
		this._stsConnectPending = false;
		this._stsConnectTarget = '';
		if (this.registeredBoxId) this.stsRequests.setOwner(this.registeredBoxId, undefined);
		this.host.requestUpdate();
		return !!this._ownerToken;
	}

	markStsDocumentOpened(): void { this._stsDocumentOpened = true; }
	markStsDocumentClosed(): void { this._stsDocumentOpened = false; }

	beginStsConnect(target: string): boolean {
		if (this._stsConnectTarget === target && (this._stsConnectPending || this._stsReady)) return false;
		this._stsConnectTarget = target;
		this._stsConnectPending = true;
		return true;
	}

	failStsConnectStart(): void { this._stsConnectPending = false; }
	markStsConnectedTarget(target: string): void { this._stsConnectTarget = target; }
	setCurrentExecutionId(executionId: string): void { this.activeExecutionId = String(executionId || '').trim(); }

	setToolExpectedOwner(owner: unknown): void {
		const candidate = owner as Partial<SqlToolExpectedOwner> | undefined;
		const connectionId = String(candidate?.connectionId || '').trim();
		const database = String(candidate?.database || '').trim();
		const targetSignature = String(candidate?.targetSignature || '');
		const principalFingerprint = String(candidate?.principalFingerprint || '').trim();
		const revocationGeneration = Number(candidate?.revocationGeneration);
		if (!connectionId || !database || !targetSignature || !principalFingerprint
			|| !Number.isSafeInteger(revocationGeneration) || revocationGeneration < 0) {
			throw new Error('SQL tool execution owner is unavailable.');
		}
		this._toolExpectedOwner = {
			connectionId, database, targetSignature, principalFingerprint, revocationGeneration,
		};
	}

	beginToolRun(executionId: string, readinessTimeoutMs = 30_000, terminalTimeoutMs = 30 * 60_000): Promise<SqlToolRunResult> {
		if (this.pendingToolRun) return Promise.reject(new Error('A SQL tool query is already running for this section.'));
		const id = String(executionId || '').trim();
		if (!id) return Promise.reject(new Error('SQL tool execution ID is unavailable.'));
		return new Promise((resolve, reject) => {
			const timer = this.createToolRunTimeout(id, readinessTimeoutMs,
				'SQL Tools Service did not become ready for tool execution.');
			this.pendingToolRun = { executionId: id, resolve, reject, timer, terminalTimeoutMs };
		});
	}

	capturePendingToolQuery(executionId: string, query: string): boolean {
		if (!this.pendingToolRun || this.pendingToolRun.executionId !== executionId) return false;
		const text = String(query || '').trim();
		if (!text) return false;
		this.pendingToolRun.query = text;
		return true;
	}

	get pendingToolQuery(): string { return this.pendingToolRun?.query ?? ''; }

	capturePendingToolOwner(connectionId: string, database: string): boolean {
		if (!this.pendingToolRun || !this._ownerToken) return false;
		this.pendingToolRun.owner = {
			connectionId,
			database,
			ownerToken: this._ownerToken,
			generation: this._targetGeneration,
		};
		clearTimeout(this.pendingToolRun.timer);
		this.pendingToolRun.timer = this.createToolRunTimeout(
			this.pendingToolRun.executionId,
			this.pendingToolRun.terminalTimeoutMs,
			'SQL tool execution did not receive a terminal response.',
		);
		return true;
	}

	resolvePendingToolRun(executionId: string | undefined, rowCount: number): boolean {
		const pending = this.pendingToolRun;
		if (!pending || executionId !== pending.executionId) return false;
		this.clearPendingToolRun();
		if (pending.owner) pending.resolve({ rowCount, executionId: pending.executionId, owner: pending.owner });
		else pending.reject(new Error('SQL tool execution owner was unavailable.'));
		return true;
	}

	rejectPendingToolRun(error: Error, expectedExecutionId?: string): boolean {
		const pending = this.pendingToolRun;
		if (!pending) {
			if (expectedExecutionId === undefined) this._toolExpectedOwner = undefined;
			return false;
		}
		if (expectedExecutionId !== undefined && expectedExecutionId !== pending.executionId) return false;
		this.clearPendingToolRun();
		pending.reject(error);
		return true;
	}

	clearToolExpectedOwner(): void {
		this._toolExpectedOwner = undefined;
	}

	private clearPendingToolRun(): void {
		if (this.pendingToolRun) clearTimeout(this.pendingToolRun.timer);
		this.pendingToolRun = undefined;
		this._toolExpectedOwner = undefined;
	}

	private createToolRunTimeout(executionId: string, timeoutMs: number, message: string): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			const pending = this.pendingToolRun;
			if (!pending || pending.executionId !== executionId) return;
			this.pendingToolRun = undefined;
			this._toolExpectedOwner = undefined;
			pending.reject(new Error(message));
			this.onToolRunTimeout?.(executionId);
		}, timeoutMs);
	}

	requestSts<T>(
		method: string,
		line: number,
		column: number,
		timeoutMs: number,
		dispatch: (requestId: string, owner: SqlStsRequestOwner) => void,
	): Promise<T | null> {
		if (!this.registeredBoxId) return Promise.resolve(null);
		return this.stsRequests.request<T>(this.registeredBoxId, timeoutMs, (requestId, owner) => {
			dispatch(requestId, owner);
		});
	}

	resolveStsResponse(requestId: string, result: unknown, ownerToken?: string, targetGeneration?: number): boolean {
		const responseOwner: SqlStsRequestOwner | undefined = ownerToken && Number.isSafeInteger(targetGeneration)
			? { ownerToken: String(ownerToken), targetGeneration: Number(targetGeneration) }
			: undefined;
		return this.stsRequests.resolve(requestId, result, responseOwner);
	}

	beginExecution(executionId: string): boolean {
		const id = String(executionId || '').trim();
		if (!id || (this.activeExecutionId && this.activeExecutionId !== id)) return false;
		this.activeExecutionId = id;
		return true;
	}

	completeExecution(executionId?: string): boolean {
		const id = String(executionId || '').trim();
		if (this.activeExecutionId && this.activeExecutionId !== id) return false;
		this.activeExecutionId = '';
		return true;
	}

	acceptsExecutionTerminal(executionId?: string): boolean {
		const id = String(executionId || '').trim();
		return !!id && !this.cancelledExecutionIds.includes(id) && id === this.activeExecutionId;
	}

	rememberCancelledExecution(executionId?: string): void {
		const id = String(executionId || '').trim();
		if (!id || this.cancelledExecutionIds.includes(id)) return;
		this.cancelledExecutionIds.push(id);
		if (this.cancelledExecutionIds.length > 16) {
			this.cancelledExecutionIds.splice(0, this.cancelledExecutionIds.length - 16);
		}
	}

	admitOwnedMessage(message: { ownerToken?: unknown; executionId?: unknown; type?: unknown }): boolean {
		if (!this._ownerToken || this._ownerToken !== String(message.ownerToken || '')) return false;
		return !SQL_TERMINAL_TYPES.has(String(message.type || ''))
			|| this.acceptsExecutionTerminal(String(message.executionId || ''));
	}

	clear(): void {
		this.rejectPendingToolRun(new Error('SQL editor closed during tool execution.'));
		this.databaseRequestId = '';
		this._ownerToken = '';
		this._stsReady = false;
		this._stsDocumentOpened = false;
		this._stsConnectTarget = '';
		this._stsConnectPending = false;
		this.activeExecutionId = '';
		this.cancelledExecutionIds.length = 0;
		if (this.registeredBoxId) this.stsRequests.clearBox(this.registeredBoxId);
		this.host.requestUpdate();
	}
}