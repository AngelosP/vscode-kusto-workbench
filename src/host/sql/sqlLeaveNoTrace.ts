import type * as vscode from 'vscode';
import { SqlQueryExecutionError } from './sqlErrors';

export const SQL_LEAVE_NO_TRACE_STORAGE_KEY = 'sql.leaveNoTraceConnections';

export class SqlLeaveNoTraceBlockedError extends SqlQueryExecutionError {
	constructor() {
		super('SQL Tools Service cannot be used with this Leave No Trace connection because it may buffer results on disk.');
		this.name = 'SqlLeaveNoTraceBlockedError';
	}
}

export class SqlLeaveNoTracePolicyChangedError extends SqlQueryExecutionError {
	constructor() {
		super('Leave No Trace policy changed while SQL work was running. Retry the query.');
		this.name = 'SqlLeaveNoTracePolicyChangedError';
	}
}

export interface SqlLeaveNoTracePolicy {
	getConnectionIds(): string[];
	getRevocationGeneration(connectionId: string): number;
	isProtected(connectionId: string): boolean;
	assertAllowed(connectionId: string): Promise<void>;
	assertProtectionMode?(connectionId: string, expectedProtected: boolean, expectedRevocationGeneration: number): Promise<void>;
	dispatchAllowed?<T>(connectionId: string, dispatch: () => T | PromiseLike<T>, expectedRevocationGeneration?: number): Promise<T>;
	dispatchProtectionMode?<T>(connectionId: string, expectedProtected: boolean, expectedRevocationGeneration: number, dispatch: () => T | PromiseLike<T>): Promise<T>;
	dispatchSnapshot?<T>(dispatch: (snapshot: {
		connectionIds: readonly string[];
		version: number;
		globallyBlocked: boolean;
		revocationGenerations: Readonly<Record<string, number>>;
	}) => T | PromiseLike<T>): Promise<T>;
	refresh(): Promise<string[]>;
	onDidChange?: vscode.Event<{
		connectionIds: string[];
		enabledConnectionIds: string[];
		disabledConnectionIds: string[];
		invalidatedConnectionIds: string[];
	}>;
}

export function getSqlLeaveNoTraceConnectionIds(
	context: Pick<vscode.ExtensionContext, 'globalState'>,
): string[] {
	const ids = context.globalState.get<unknown>(SQL_LEAVE_NO_TRACE_STORAGE_KEY);
	return Array.isArray(ids)
		? [...new Set(ids.map(id => String(id || '').trim()).filter(Boolean))]
		: [];
}

export function isSqlLeaveNoTraceConnection(
	context: Pick<vscode.ExtensionContext, 'globalState'>,
	connectionId: string,
): boolean {
	return getSqlLeaveNoTraceConnectionIds(context).includes(connectionId);
}

export function assertSqlConnectionMayUseSts(
	context: Pick<vscode.ExtensionContext, 'globalState'>,
	connectionId: string,
): void {
	if (isSqlLeaveNoTraceConnection(context, connectionId)) {
		throw new SqlLeaveNoTraceBlockedError();
	}
}