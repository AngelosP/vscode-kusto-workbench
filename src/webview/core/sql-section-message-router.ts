import { buildSchemaInfo } from '../shared/schema-utils.js';
import {
	isSqlDatabaseDiscoveryHostMessageType,
	parseSqlDatabaseDiscoveryHostMessage,
	type SqlDatabaseDiscoveryHostMessage,
} from '../../shared/sqlDatabaseDiscoveryProtocol.js';
import {
	isSqlSchemaHostMessageType,
	parseSqlSchemaHostMessage,
	type SqlSchemaHostMessage,
	type SqlSchemaPayload,
} from '../../shared/sqlSchemaProtocol.js';
import {
	admitSqlStsEditorLanguageHostMessage,
	type SqlStsEditorLanguageHostMessage,
} from '../../shared/sqlStsEditorLanguageProtocol.js';
import {
	admitCopilotInlineCompletionHostMessage,
} from '../../shared/copilotInlineCompletionProtocol.js';

export interface SqlSectionSessionTarget {
	readonly boxId: string;
	readonly instanceId: string;
	readonly targetGeneration: number;
	readonly ownerToken: string;
	readonly stsReady: boolean;
	setStsReady(ready: boolean, ownerToken?: string, targetGeneration?: number): boolean;
	setExecutionOwner(ownerToken: string, targetGeneration?: number): boolean;
	requestSts<T>(
		method: string,
		line: number,
		column: number,
		timeoutMs: number,
		dispatch: (requestId: string, owner: { ownerToken: string; targetGeneration: number }) => void,
	): Promise<T | null>;
	advanceTargetGeneration(preserve?: boolean): number;
	adoptHostGeneration(generation: number): boolean;
	clearDatabaseRequest(): void;
	beginDatabaseRequest(requestId: string, generation: number): boolean;
	acceptDatabaseResponse(requestId: string | undefined, generation: number): boolean;
	completeDatabaseRequest(requestId: string): boolean;
	admitOwnedMessage(message: { ownerToken?: unknown; executionId?: unknown; type?: unknown }): boolean;
	resolveStsResponse(requestId: string, result: unknown, ownerToken: string, targetGeneration: number): boolean;
	clear(): void;
}

export type SqlSectionMessageRouteResult = 'handled' | 'rejected' | 'not-sql';

interface SqlSectionElement {
	readonly sqlSession?: SqlSectionSessionTarget;
	getSqlConnectionId?(): string;
	getConnectionId?(): string;
	getDatabase?(): string;
	invalidateOwner?(retired?: boolean): void;
	setSqlConnectionId?(connectionId: string): void;
	clearResults?(): void;
	setDatabasesLoading?(loading: boolean): void;
	setSchemaInfo?(info: unknown): void;
	notifyStsConnectionError?(error: string): void;
	setStsReady?(ready: boolean, ownerToken?: string, targetGeneration?: number): void;
	setExecutionOwner?(ownerToken: string, targetGeneration?: number): void;
	admitSqlCopilotMessage?(message: unknown): boolean;
}

export interface SqlSectionMessageRouterEffects {
	getSection(boxId: string): SqlSectionElement | null | undefined;
	getDerivedSourceBoxId?(boxId: string): string | undefined;
	clearSchema(boxId: string): void;
	setSchema(boxId: string, schema: SqlSchemaPayload): void;
	updateDatabases(boxId: string, databases: string[], connectionId: string): void;
	reportDatabasesError(boxId: string, error: string, connectionId: string): void;
	handleStsResponse(boxId: string, requestId: string, result: unknown, ownerToken: string, targetGeneration: number): void;
	handleStsDiagnostics(boxId: string, markers: object[]): void;
	clearPolicyBox(boxId: string): void;
}

const SQL_OWNER_SENSITIVE_MESSAGE_TYPES = new Set([
	'queryResult', 'queryError', 'queryCancelled', 'ensureResultsVisible',
	'copilotWriteQueryStatus', 'copilotWriteQueryToolResult', 'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded', 'copilotUserQuerySnapshot', 'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting', 'copilotDevNotesContextLoaded', 'copilotDevNoteToolCall',
	'copilotClarifyingQuestion', 'copilotWriteQueryDone', 'copilotInlineCompletionResult',
]);

const SQL_COPILOT_REQUEST_MESSAGE_TYPES = new Set([
	'copilotWriteQueryStatus', 'copilotWriteQueryToolResult', 'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded', 'copilotUserQuerySnapshot', 'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting', 'copilotDevNotesContextLoaded', 'copilotDevNoteToolCall',
	'copilotClarifyingQuestion', 'copilotWriteQueryDone', 'ensureResultsVisible',
]);

function isSqlCopilotAvailabilityMessage(message: Record<string, unknown>): boolean {
	return message.type === 'copilotWriteQueryStatus' && message.role === 'availability';
}

export function isSqlCopilotRequestMessage(message: Record<string, unknown>): boolean {
	return typeof message.type === 'string'
		&& SQL_COPILOT_REQUEST_MESSAGE_TYPES.has(message.type)
		&& !isSqlCopilotAvailabilityMessage(message);
}

const sessionsByBoxId = new Map<string, SqlSectionSessionTarget>();
const derivedComparisonByBoxId = new Map<string, {
	sourceBoxId: string;
	executionId: string;
	pendingExecutionId: string;
}>();

export function registerSqlSectionSession(target: SqlSectionSessionTarget): void {
	const boxId = String(target.boxId || '').trim();
	if (boxId) sessionsByBoxId.set(boxId, target);
}

export function unregisterSqlSectionSession(boxId: string, target: SqlSectionSessionTarget): void {
	const id = String(boxId || '').trim();
	if (sessionsByBoxId.get(id) === target) sessionsByBoxId.delete(id);
}

export function getSqlSectionSession(boxId: string): SqlSectionSessionTarget | undefined {
	return sessionsByBoxId.get(String(boxId || '').trim());
}

export function registerSqlDerivedComparisonSession(boxId: string, sourceBoxId: string): void {
	const id = String(boxId || '').trim();
	const sourceId = String(sourceBoxId || '').trim();
	if (!id || !sourceId || id === sourceId) return;
	const current = derivedComparisonByBoxId.get(id);
	if (current?.sourceBoxId === sourceId) return;
	derivedComparisonByBoxId.set(id, { sourceBoxId: sourceId, executionId: '', pendingExecutionId: '' });
}

export function unregisterSqlDerivedComparisonSession(boxId: string): void {
	derivedComparisonByBoxId.delete(String(boxId || '').trim());
}

export function unregisterSqlDerivedComparisonsForSource(sourceBoxId: string): void {
	const sourceId = String(sourceBoxId || '').trim();
	for (const [boxId, comparison] of derivedComparisonByBoxId) {
		if (comparison.sourceBoxId === sourceId) derivedComparisonByBoxId.delete(boxId);
	}
}

export function commitSqlDerivedComparisonExecution(boxId: string, executionId: string): boolean {
	const id = String(boxId || '').trim();
	const execution = String(executionId || '').trim();
	const comparison = derivedComparisonByBoxId.get(id);
	if (!comparison || !execution || comparison.pendingExecutionId !== execution
		|| (comparison.executionId && comparison.executionId !== execution)) return false;
	comparison.pendingExecutionId = '';
	comparison.executionId = execution;
	return true;
}

export function rollbackSqlDerivedComparisonExecution(boxId: string, executionId: string): void {
	const comparison = derivedComparisonByBoxId.get(String(boxId || '').trim());
	const execution = String(executionId || '').trim();
	if (comparison?.pendingExecutionId === execution) comparison.pendingExecutionId = '';
	if (comparison?.executionId === execution) comparison.executionId = '';
}

export function rollbackSqlDerivedComparisonExecutionReservation(boxId: string, executionId: string): void {
	const comparison = derivedComparisonByBoxId.get(String(boxId || '').trim());
	if (comparison?.pendingExecutionId === String(executionId || '').trim()) {
		comparison.pendingExecutionId = '';
	}
}

function getMessageTarget(
	boxId: string,
	effects: SqlSectionMessageRouterEffects,
): { section: SqlSectionElement | null | undefined; session: SqlSectionSessionTarget | undefined } {
	const section = effects.getSection(boxId);
	return { section, session: getSqlSectionSession(boxId) ?? section?.sqlSession };
}

function messageMatchesInstance(
	session: SqlSectionSessionTarget | undefined,
	message: { readonly sectionInstanceId?: unknown },
): session is SqlSectionSessionTarget {
	return !!session && session.instanceId === String(message.sectionInstanceId || '');
}

function admitOwnerSensitiveMessage(
	boxId: string,
	message: Record<string, unknown>,
	effects: SqlSectionMessageRouterEffects,
): boolean {
	const { section, session } = getMessageTarget(boxId, effects);
	let comparison = derivedComparisonByBoxId.get(boxId);
	if (!comparison) {
		const sourceBoxId = String(effects.getDerivedSourceBoxId?.(boxId) || '').trim();
		if (sourceBoxId) {
			registerSqlDerivedComparisonSession(boxId, sourceBoxId);
			comparison = derivedComparisonByBoxId.get(boxId);
		}
	}
	if (!comparison && !section && !session) return !message.ownerToken;
	if (typeof message.ownerToken !== 'string' || !message.ownerToken) return false;
	if (!comparison) {
		const ownerAdmitted = session?.admitOwnedMessage(message) === true;
		return ownerAdmitted
			&& (!isSqlCopilotRequestMessage(message)
				|| section?.admitSqlCopilotMessage?.(message) === true);
	}
	if (session?.ownerToken && session.ownerToken === message.ownerToken) {
		return session.admitOwnedMessage(message)
			&& (!isSqlCopilotRequestMessage(message)
				|| section?.admitSqlCopilotMessage?.(message) === true);
	}
	const sourceSection = effects.getSection(comparison.sourceBoxId);
	const sourceSession = getSqlSectionSession(comparison.sourceBoxId) ?? sourceSection?.sqlSession;
	if (!sourceSession?.ownerToken || sourceSession.ownerToken !== message.ownerToken) return false;
	if (isSqlCopilotRequestMessage(message)
		&& sourceSection?.admitSqlCopilotMessage?.(message) !== true) return false;

	const type = String(message.type || '');
	const executionId = String(message.executionId || '').trim();
	if (type === 'copilotWriteQueryExecuting') {
		if (!executionId) return false;
		if (message.executing === true) {
			if ((comparison.executionId && comparison.executionId !== executionId)
				|| (comparison.pendingExecutionId && comparison.pendingExecutionId !== executionId)) return false;
			comparison.pendingExecutionId = executionId;
			return true;
		}
		if (comparison.executionId === executionId) {
			comparison.executionId = '';
			return true;
		}
		if (comparison.pendingExecutionId === executionId) {
			comparison.pendingExecutionId = '';
			return true;
		}
		return false;
	}
	if (type === 'queryResult' || type === 'queryError' || type === 'queryCancelled') {
		if (!executionId || comparison.executionId !== executionId) return false;
		comparison.executionId = '';
	}
	return true;
}

export function routeSqlSectionMessage(
	message: Record<string, unknown>,
	effects: SqlSectionMessageRouterEffects,
): SqlSectionMessageRouteResult {
	const inlineCompletionAdmission = admitCopilotInlineCompletionHostMessage(message);
	if (inlineCompletionAdmission.recognized) {
		if (!inlineCompletionAdmission.parsed.ok) return 'rejected';
		message = inlineCompletionAdmission.parsed.value as unknown as Record<string, unknown>;
	}
	let stsMessage: SqlStsEditorLanguageHostMessage | undefined;
	const stsAdmission = admitSqlStsEditorLanguageHostMessage(message);
	if (stsAdmission.recognized) {
		if (!stsAdmission.parsed.ok) return 'rejected';
		stsMessage = stsAdmission.parsed.value;
		message = stsAdmission.parsed.value as unknown as Record<string, unknown>;
	}
	let databaseMessage: SqlDatabaseDiscoveryHostMessage | undefined;
	if (isSqlDatabaseDiscoveryHostMessageType(message)) {
		const parsed = parseSqlDatabaseDiscoveryHostMessage(message);
		if (!parsed.ok) return 'rejected';
		databaseMessage = parsed.value;
		message = parsed.value as unknown as Record<string, unknown>;
	}
	let schemaMessage: SqlSchemaHostMessage | undefined;
	if (isSqlSchemaHostMessageType(message)) {
		const parsed = parseSqlSchemaHostMessage(message);
		if (!parsed.ok) return 'rejected';
		schemaMessage = parsed.value;
		message = parsed.value as unknown as Record<string, unknown>;
	}
	const type = String(message.type || '');
	if (message.boxId !== undefined && typeof message.boxId !== 'string') return 'rejected';
	const boxId = typeof message.boxId === 'string' ? message.boxId.trim() : '';
	if (type === 'copilotWriteQueryExecuting'
		&& (typeof message.boxId !== 'string' || !boxId || message.boxId !== boxId
			|| typeof message.executionId !== 'string' || !message.executionId.trim()
			|| message.executionId !== message.executionId.trim()
			|| typeof message.executing !== 'boolean')) return 'rejected';
	if (boxId && SQL_OWNER_SENSITIVE_MESSAGE_TYPES.has(type)
		&& !isSqlCopilotAvailabilityMessage(message)) {
		if (!admitOwnerSensitiveMessage(boxId, message, effects)) return 'rejected';
	}

	switch (type) {
		case 'sqlConnectionOwnerChanged': {
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, message)
				|| !session.adoptHostGeneration(Number(message.targetGeneration))) return 'rejected';
			effects.clearSchema(boxId);
			effects.handleStsDiagnostics(boxId, []);
			if (typeof section?.invalidateOwner === 'function') section.invalidateOwner(message.retired === true);
			else section?.setSqlConnectionId?.('');
			section?.clearResults?.();
			effects.clearPolicyBox(boxId);
			return 'handled';
		}
		case 'sqlDatabasesLoading': {
			const delivery = databaseMessage!;
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, delivery)
				|| !session.beginDatabaseRequest(delivery.requestId, delivery.targetGeneration)) return 'rejected';
			section?.setDatabasesLoading?.(true);
			return 'handled';
		}
		case 'sqlDatabasesData':
		case 'sqlDatabasesError': {
			const delivery = databaseMessage!;
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, delivery)
				|| !session.acceptDatabaseResponse(delivery.requestId, delivery.targetGeneration)) return 'rejected';
			if (delivery.type === 'sqlDatabasesData') {
				effects.updateDatabases(boxId, delivery.databases, delivery.sqlConnectionId);
			} else if (delivery.type === 'sqlDatabasesError') {
				effects.reportDatabasesError(boxId, delivery.error, delivery.sqlConnectionId);
			} else return 'rejected';
			session.completeDatabaseRequest(delivery.requestId);
			return 'handled';
		}
		case 'sqlSchemaData': {
			const delivery = schemaMessage!;
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!section || !messageMatchesInstance(session, delivery)) return 'rejected';
			const connectionId = String(section.getSqlConnectionId?.() ?? section.getConnectionId?.() ?? '');
			const database = String(section.getDatabase?.() || '');
			if (connectionId !== delivery.sqlConnectionId
				|| database !== delivery.database
				|| session.targetGeneration !== delivery.targetGeneration) return 'rejected';
			if (delivery.schema === null) {
				section.setSchemaInfo?.(buildSchemaInfo(delivery.schemaMeta.errorMessage || 'Schema failed', true));
				return 'handled';
			}
			const schema = delivery.schema;
			effects.setSchema(boxId, schema);
			const { tablesCount, columnsCount, fromCache } = delivery.schemaMeta;
			section.setSchemaInfo?.(buildSchemaInfo(
				`${tablesCount} tables, ${columnsCount} cols${fromCache ? ' (cached)' : ''}`,
				false,
				{ fromCache, tablesCount, columnsCount, functionsCount: 0 },
			));
			return 'handled';
		}
		case 'stsResponse': {
			const delivery = stsMessage!;
			if (delivery.type !== 'stsResponse') return 'rejected';
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, delivery)) return 'rejected';
			effects.handleStsResponse(
				boxId,
				delivery.requestId,
				delivery.result,
				delivery.ownerToken,
				delivery.targetGeneration,
			);
			return 'handled';
		}
		case 'stsDiagnostics': {
			const delivery = stsMessage!;
			if (delivery.type !== 'stsDiagnostics') return 'rejected';
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, delivery)
				|| (!session.stsReady && delivery.markers.length > 0)) return 'rejected';
			effects.handleStsDiagnostics(boxId, delivery.markers);
			return 'handled';
		}
		case 'stsConnectionState': {
			const delivery = stsMessage!;
			if (delivery.type !== 'stsConnectionState') return 'rejected';
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!section || !messageMatchesInstance(session, delivery)) return 'rejected';
			if (delivery.targetGeneration !== undefined
				&& session.targetGeneration !== delivery.targetGeneration) return 'rejected';
			if (delivery.state === 'ready' && (
				String(section.getConnectionId?.() ?? section.getSqlConnectionId?.() ?? '') !== delivery.connectionId
				|| String(section.getDatabase?.() || '') !== delivery.database
			)) return 'rejected';
			if (delivery.state === 'error') {
				section.notifyStsConnectionError?.(delivery.error || 'SQL Tools Service connection failed.');
			} else {
				section.setStsReady?.(true, delivery.ownerToken, delivery.targetGeneration);
			}
			return 'handled';
		}
		case 'sqlExecutionOwnerState': {
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!section || !messageMatchesInstance(session, message)
				|| session.targetGeneration !== Number(message.targetGeneration ?? 0)) return 'rejected';
			section.setExecutionOwner?.(String(message.ownerToken || ''), Number(message.targetGeneration));
			return 'handled';
		}
		default:
			return 'not-sql';
	}
}

export function clearSqlSectionSessionsForTest(): void {
	for (const target of sessionsByBoxId.values()) target.clear();
	sessionsByBoxId.clear();
	derivedComparisonByBoxId.clear();
}