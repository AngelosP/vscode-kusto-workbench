import type { KustoEditorLifecycleIdentity } from './kustoSchemaLifecycle.js';

export type KustoExecutionProducer = 'manual' | 'copilot' | 'comparison' | 'tool';

export type KustoSectionExecutionTarget = KustoEditorLifecycleIdentity & Readonly<{
	engine: 'kusto';
	boxId: string;
	connectionId: string;
	database: string;
}>;

export type KustoComparisonRunIdentity = Readonly<{
	sourceBoxId: string;
	sourceExecutionId: string;
	comparisonBoxId: string;
}>;

export type KustoExecutionRequestIdentity = KustoSectionExecutionTarget & Readonly<{
	executionId: string;
	producer: KustoExecutionProducer;
	query?: string;
	copilotRequestId?: string;
	comparisonRun?: KustoComparisonRunIdentity;
}>;

export type KustoExecutionReservation = KustoExecutionRequestIdentity & Readonly<{
	reservationSequence: number;
}>;

export type KustoDispatchIdentity = Readonly<{
	dispatchAttempt: number;
	connectionRevision: number;
	leaveNoTraceRevision: number;
	connectionIdentityKey: string;
	clusterEndpoint: string;
	authorityId?: string;
	accountPartition: string;
	authSessionGeneration: number;
	clientActivityId: string;
}>;

export type KustoExecutionTerminalStamp = KustoExecutionReservation & Readonly<{
	dispatch?: KustoDispatchIdentity;
}>;

export type KustoExecutionSuccessStamp = KustoExecutionReservation & Readonly<{
	dispatch: KustoDispatchIdentity;
}>;

export type KustoCopilotRequestIdentity = KustoEditorLifecycleIdentity & Readonly<{
	boxId: string;
	copilotRequestId: string;
}>;

export type KustoOptimizeRequestIdentity = KustoEditorLifecycleIdentity & Readonly<{
	boxId: string;
	optimizeRequestId: string;
}>;

export type KustoSectionExecutionOutcome<TResult = unknown> = Readonly<{
	status: 'success' | 'failed' | 'cancelled' | 'superseded';
	executionId: string;
	result?: TResult;
	error?: string;
}>;

export type PreparedComparisonSection = Readonly<{
	boxId: string;
	kustoTarget?: KustoSectionExecutionTarget;
}>;

export type KustoSectionLifecycleOwner = KustoEditorLifecycleIdentity & Readonly<{
	boxId: string;
	connectionId?: string;
	database?: string;
	connectionRevision?: number;
	connectionIdentityKey?: string;
}>;

export function hasKustoExecutionRequestIdentity(value: unknown): value is KustoExecutionRequestIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	const comparisonRun = candidate.comparisonRun as Record<string, unknown> | undefined;
	const hasValidComparisonRun = comparisonRun === undefined || (
		candidate.producer === 'comparison'
		&& typeof comparisonRun.sourceBoxId === 'string' && comparisonRun.sourceBoxId.length > 0
		&& typeof comparisonRun.sourceExecutionId === 'string' && comparisonRun.sourceExecutionId.length > 0
		&& typeof comparisonRun.comparisonBoxId === 'string' && comparisonRun.comparisonBoxId.length > 0
		&& ((candidate.boxId === comparisonRun.sourceBoxId && candidate.executionId === comparisonRun.sourceExecutionId)
			|| candidate.boxId === comparisonRun.comparisonBoxId)
	);
	return candidate.engine === 'kusto'
		&& typeof candidate.boxId === 'string' && candidate.boxId.length > 0
		&& typeof candidate.executionId === 'string' && candidate.executionId.length > 0
		&& typeof candidate.connectionId === 'string' && candidate.connectionId.length > 0
		&& typeof candidate.database === 'string' && candidate.database.length > 0
		&& typeof candidate.sectionInstanceId === 'string' && candidate.sectionInstanceId.length > 0
		&& Number.isSafeInteger(candidate.targetGeneration)
		&& Number(candidate.targetGeneration) >= 0
		&& (candidate.copilotRequestId === undefined
			|| (typeof candidate.copilotRequestId === 'string' && candidate.copilotRequestId.length > 0))
		&& (candidate.query === undefined || typeof candidate.query === 'string')
		&& hasValidComparisonRun
		&& (candidate.producer === 'manual' || candidate.producer === 'copilot'
			|| candidate.producer === 'comparison' || candidate.producer === 'tool');
}

export function hasKustoExecutionReservation(value: unknown): value is KustoExecutionReservation {
	if (!hasKustoExecutionRequestIdentity(value)) return false;
	const candidate = value as unknown as Record<string, unknown>;
	return Number.isSafeInteger(candidate.reservationSequence)
		&& Number(candidate.reservationSequence) > 0;
}

export function hasKustoDispatchIdentity(value: unknown): value is KustoDispatchIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.dispatchAttempt) && Number(candidate.dispatchAttempt) > 0
		&& Number.isSafeInteger(candidate.connectionRevision) && Number(candidate.connectionRevision) >= 0
		&& Number.isSafeInteger(candidate.leaveNoTraceRevision) && Number(candidate.leaveNoTraceRevision) >= 0
		&& typeof candidate.connectionIdentityKey === 'string' && candidate.connectionIdentityKey.length > 0
		&& typeof candidate.clusterEndpoint === 'string' && candidate.clusterEndpoint.length > 0
		&& (candidate.authorityId === undefined || typeof candidate.authorityId === 'string')
		&& typeof candidate.accountPartition === 'string' && candidate.accountPartition.length > 0
		&& Number.isSafeInteger(candidate.authSessionGeneration) && Number(candidate.authSessionGeneration) >= 0
		&& typeof candidate.clientActivityId === 'string' && candidate.clientActivityId.length > 0;
}

export function hasKustoExecutionTerminalStamp(value: unknown, requireDispatch = false): value is KustoExecutionTerminalStamp {
	if (!hasKustoExecutionReservation(value)) return false;
	const dispatch = (value as KustoExecutionTerminalStamp).dispatch;
	if (requireDispatch) return hasKustoDispatchIdentity(dispatch);
	return dispatch === undefined || hasKustoDispatchIdentity(dispatch);
}

export function kustoExecutionIdentityEquals(
	left: Pick<KustoExecutionRequestIdentity, 'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>,
	right: Pick<KustoExecutionRequestIdentity, 'boxId' | 'executionId' | 'sectionInstanceId' | 'targetGeneration'>,
): boolean {
	return left.boxId === right.boxId
		&& left.executionId === right.executionId
		&& left.sectionInstanceId === right.sectionInstanceId
		&& left.targetGeneration === right.targetGeneration;
}

export function kustoExecutionRequestIdentityEquals(
	left: KustoExecutionRequestIdentity,
	right: KustoExecutionRequestIdentity,
): boolean {
	return kustoExecutionIdentityEquals(left, right)
		&& left.engine === right.engine
		&& left.connectionId === right.connectionId
		&& left.database.toLowerCase() === right.database.toLowerCase()
		&& left.producer === right.producer
		&& (left.copilotRequestId ?? '') === (right.copilotRequestId ?? '')
		&& (left.comparisonRun?.sourceBoxId ?? '') === (right.comparisonRun?.sourceBoxId ?? '')
		&& (left.comparisonRun?.sourceExecutionId ?? '') === (right.comparisonRun?.sourceExecutionId ?? '')
		&& (left.comparisonRun?.comparisonBoxId ?? '') === (right.comparisonRun?.comparisonBoxId ?? '');
}

export function hasKustoCopilotRequestIdentity(value: unknown): value is KustoCopilotRequestIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.boxId === 'string' && candidate.boxId.length > 0
		&& typeof candidate.copilotRequestId === 'string' && candidate.copilotRequestId.length > 0
		&& typeof candidate.sectionInstanceId === 'string' && candidate.sectionInstanceId.length > 0
		&& Number.isSafeInteger(candidate.targetGeneration) && Number(candidate.targetGeneration) >= 0;
}

export function kustoCopilotRequestIdentityEquals(
	left: KustoCopilotRequestIdentity,
	right: KustoCopilotRequestIdentity,
): boolean {
	return left.boxId === right.boxId
		&& left.copilotRequestId === right.copilotRequestId
		&& left.sectionInstanceId === right.sectionInstanceId
		&& left.targetGeneration === right.targetGeneration;
}

export function hasKustoOptimizeRequestIdentity(value: unknown): value is KustoOptimizeRequestIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.boxId === 'string' && candidate.boxId.length > 0
		&& typeof candidate.optimizeRequestId === 'string' && candidate.optimizeRequestId.length > 0
		&& typeof candidate.sectionInstanceId === 'string' && candidate.sectionInstanceId.length > 0
		&& Number.isSafeInteger(candidate.targetGeneration) && Number(candidate.targetGeneration) >= 0;
}

export function kustoOptimizeRequestIdentityEquals(
	left: KustoOptimizeRequestIdentity,
	right: KustoOptimizeRequestIdentity,
): boolean {
	return left.boxId === right.boxId
		&& left.optimizeRequestId === right.optimizeRequestId
		&& left.sectionInstanceId === right.sectionInstanceId
		&& left.targetGeneration === right.targetGeneration;
}