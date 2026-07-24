import { buildSchemaInfo } from '../shared/schema-utils.js';

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
	resolveStsResponse(requestId: string, result: unknown, ownerToken?: string, targetGeneration?: number): boolean;
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
}

export interface SqlSectionMessageRouterEffects {
	getSection(boxId: string): SqlSectionElement | null | undefined;
	getDerivedSourceBoxId?(boxId: string): string | undefined;
	clearSchema(boxId: string): void;
	setSchema(boxId: string, schema: unknown): void;
	updateDatabases(boxId: string, databases: unknown, connectionId: unknown): void;
	reportDatabasesError(boxId: string, error: unknown, connectionId: unknown): void;
	handleStsResponse(boxId: string, requestId: string, result: unknown, ownerToken?: string, targetGeneration?: number): void;
	handleStsDiagnostics(boxId: string, markers: unknown[]): void;
	clearPolicyBox(boxId: string): void;
}

const SQL_OWNER_SENSITIVE_MESSAGE_TYPES = new Set([
	'queryResult', 'queryError', 'queryCancelled', 'ensureResultsVisible',
	'copilotWriteQueryStatus', 'copilotWriteQueryToolResult', 'copilotExecutedQuery',
	'copilotGeneralQueryRulesLoaded', 'copilotUserQuerySnapshot', 'copilotWriteQuerySetQuery',
	'copilotWriteQueryExecuting', 'copilotDevNotesContextLoaded', 'copilotDevNoteToolCall',
	'copilotClarifyingQuestion', 'copilotWriteQueryDone', 'copilotInlineCompletionResult',
]);

const sessionsByBoxId = new Map<string, SqlSectionSessionTarget>();
const derivedComparisonByBoxId = new Map<string, { sourceBoxId: string; executionId: string }>();

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
	derivedComparisonByBoxId.set(id, { sourceBoxId: sourceId, executionId: '' });
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

function getMessageTarget(
	boxId: string,
	effects: SqlSectionMessageRouterEffects,
): { section: SqlSectionElement | null | undefined; session: SqlSectionSessionTarget | undefined } {
	const section = effects.getSection(boxId);
	return { section, session: getSqlSectionSession(boxId) ?? section?.sqlSession };
}

function messageMatchesInstance(
	session: SqlSectionSessionTarget | undefined,
	message: Record<string, unknown>,
): session is SqlSectionSessionTarget {
	return !!session && session.instanceId === String(message.sectionInstanceId || '');
}

function admitOwnerSensitiveMessage(
	boxId: string,
	message: Record<string, unknown>,
	effects: SqlSectionMessageRouterEffects,
): boolean {
	const { section, session } = getMessageTarget(boxId, effects);
	if (session) return session.admitOwnedMessage(message);

	let comparison = derivedComparisonByBoxId.get(boxId);
	if (!comparison) {
		const sourceBoxId = String(effects.getDerivedSourceBoxId?.(boxId) || '').trim();
		if (sourceBoxId) {
			registerSqlDerivedComparisonSession(boxId, sourceBoxId);
			comparison = derivedComparisonByBoxId.get(boxId);
		}
	}
	if (!comparison) return !section && !message.ownerToken;
	const sourceSession = getSqlSectionSession(comparison.sourceBoxId)
		?? effects.getSection(comparison.sourceBoxId)?.sqlSession;
	if (!sourceSession?.ownerToken || sourceSession.ownerToken !== String(message.ownerToken || '')) return false;

	const type = String(message.type || '');
	const executionId = String(message.executionId || '').trim();
	if (type === 'copilotWriteQueryExecuting') {
		if (!executionId) return false;
		if (message.executing === true) {
			if (comparison.executionId && comparison.executionId !== executionId) return false;
			comparison.executionId = executionId;
			return true;
		}
		if (comparison.executionId !== executionId) return false;
		comparison.executionId = '';
		return true;
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
	const type = String(message.type || '');
	const boxId = String(message.boxId || '').trim();
	if (boxId && SQL_OWNER_SENSITIVE_MESSAGE_TYPES.has(type)) {
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
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, message)
				|| !session.beginDatabaseRequest(String(message.requestId || ''), Number(message.targetGeneration ?? 0))) return 'rejected';
			section?.setDatabasesLoading?.(true);
			return 'handled';
		}
		case 'sqlDatabasesData':
		case 'sqlDatabasesError': {
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
			if (!messageMatchesInstance(session, message)
				|| !session.acceptDatabaseResponse(requestId, Number(message.targetGeneration ?? 0))) return 'rejected';
			if (type === 'sqlDatabasesData') effects.updateDatabases(boxId, message.databases, message.sqlConnectionId);
			else effects.reportDatabasesError(boxId, message.error, message.sqlConnectionId);
			session.completeDatabaseRequest(requestId!);
			return 'handled';
		}
		case 'sqlSchemaData': {
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!section || !messageMatchesInstance(session, message)) return 'rejected';
			const connectionId = String(section.getSqlConnectionId?.() ?? section.getConnectionId?.() ?? '');
			const database = String(section.getDatabase?.() || '');
			if (connectionId !== String(message.sqlConnectionId || '')
				|| database !== String(message.database || '')
				|| session.targetGeneration !== Number(message.targetGeneration ?? 0)) return 'rejected';
			const meta = (message.schemaMeta && typeof message.schemaMeta === 'object')
				? message.schemaMeta as Record<string, unknown>
				: {};
			if (meta.error) {
				section.setSchemaInfo?.(buildSchemaInfo(String(meta.errorMessage || 'Schema failed'), true));
				return 'handled';
			}
			const schema = message.schema as { tables?: unknown[]; columnsByTable?: Record<string, Record<string, unknown>> } | undefined;
			if (!schema) return 'handled';
			effects.setSchema(boxId, schema);
			const tablesCount = Number(meta.tablesCount ?? schema.tables?.length ?? 0);
			let columnsCount = Number(meta.columnsCount ?? 0);
			if (!columnsCount && schema.columnsByTable) {
				for (const table of Object.keys(schema.columnsByTable)) {
					columnsCount += Object.keys(schema.columnsByTable[table] || {}).length;
				}
			}
			const fromCache = !!meta.fromCache;
			section.setSchemaInfo?.(buildSchemaInfo(
				`${tablesCount} tables, ${columnsCount} cols${fromCache ? ' (cached)' : ''}`,
				false,
				{ fromCache, tablesCount, columnsCount, functionsCount: 0 },
			));
			return 'handled';
		}
		case 'stsResponse': {
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			if (!messageMatchesInstance(session, message)) return 'rejected';
			effects.handleStsResponse(
				boxId,
				String(message.requestId || ''),
				message.result,
				typeof message.ownerToken === 'string' ? message.ownerToken : undefined,
				typeof message.targetGeneration === 'number' ? message.targetGeneration : undefined,
			);
			return 'handled';
		}
		case 'stsDiagnostics': {
			if (!boxId) return 'rejected';
			const { session } = getMessageTarget(boxId, effects);
			const markers = Array.isArray(message.markers) ? message.markers : [];
			if (!messageMatchesInstance(session, message) || (!session.stsReady && markers.length > 0)) return 'rejected';
			effects.handleStsDiagnostics(boxId, markers);
			return 'handled';
		}
		case 'stsConnectionState': {
			if (!boxId) return 'rejected';
			const { section, session } = getMessageTarget(boxId, effects);
			if (!section || !messageMatchesInstance(session, message)) return 'rejected';
			if (message.targetGeneration !== undefined
				&& session.targetGeneration !== Number(message.targetGeneration)) return 'rejected';
			const state = String(message.state || '');
			if (state === 'ready' && (
				String(section.getConnectionId?.() ?? section.getSqlConnectionId?.() ?? '') !== String(message.connectionId || '')
				|| String(section.getDatabase?.() || '') !== String(message.database || '')
			)) return 'rejected';
			if (state === 'error') {
				section.notifyStsConnectionError?.(String(message.error || 'SQL Tools Service connection failed.'));
			} else {
				const generation = typeof message.targetGeneration === 'number' ? message.targetGeneration : undefined;
				section.setStsReady?.(state === 'ready', String(message.ownerToken || ''), generation);
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