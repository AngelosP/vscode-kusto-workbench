export type ResultArtifactProducer = Readonly<{
	engine?: string;
	boxId: string;
	executionId?: string;
	sectionInstanceId?: string;
	targetGeneration?: number;
	reservationSequence?: number;
	connectionId?: string;
	database?: string;
	query?: string;
	producer?: string;
	dispatch?: Readonly<Record<string, unknown>>;
}>;

export type ResultArtifactPolicyStamp = Readonly<{
	accountPartition?: string;
	authSessionGeneration?: number;
	leaveNoTraceRevision?: number;
	connectionRevision?: number;
	connectionIdentityKey?: string;
	exposeToActiveContent?: boolean;
	sendToModel?: boolean;
	shareToClipboard?: boolean;
	exportToCsv?: boolean;
}>;

export type ResultArtifactSourcePolicy = Readonly<ResultArtifactPolicyStamp & {
	sourceArtifactId: string;
}>;

export type ResultArtifactPolicy = Readonly<ResultArtifactPolicyStamp & {
	sourcePolicies?: readonly ResultArtifactSourcePolicy[];
}>;

export type ResultArtifactLineage = Readonly<{
	sourceArtifactId: string;
	role?: string;
}>;

export type PersistedResultArtifactV1 = Readonly<{
	version: 1;
	artifactId: string;
	sourceBoxId: string;
	revision: number;
	createdAt: number;
	producer?: ResultArtifactProducer;
	policy?: ResultArtifactPolicy;
	lineage?: readonly ResultArtifactLineage[];
}>;

export type ResultArtifactPublication = Readonly<{
	producer?: ResultArtifactProducer;
	policy?: ResultArtifactPolicy;
	lineage?: readonly ResultArtifactLineage[];
	assignedIdentity?: Readonly<{
		artifactId: string;
		sourceBoxId: string;
		revision: number;
		createdAt: number;
	}>;
	persistedIdentity?: Readonly<{
		artifactId: string;
		sourceBoxId: string;
		revision: number;
		createdAt: number;
	}>;
}>;

export type ResultArtifact = Readonly<{
	artifactId: string;
	sourceBoxId: string;
	resultIndex: number;
	revision: number;
	createdAt: number;
	restored: boolean;
	columns: readonly unknown[];
	rows: readonly unknown[];
	metadata: Readonly<Record<string, unknown>>;
	producer?: ResultArtifactProducer;
	policy?: ResultArtifactPolicy;
	lineage: readonly ResultArtifactLineage[];
}>;

export type DerivedResultArtifactInput = Readonly<{
	artifact: ResultArtifact;
	role?: string;
}>;

export type ResultSourceRef = Readonly<{
	sourceBoxId: string;
	resultIndex: number;
}>;

export function createResultSourceRef(
	sourceBoxIdValue: unknown,
	resultIndexValue: unknown = 0,
): ResultSourceRef | undefined {
	const sourceBoxId = typeof sourceBoxIdValue === 'string' ? sourceBoxIdValue.trim() : '';
	if (!sourceBoxId || sourceBoxId.length > 4096
		|| typeof resultIndexValue !== 'number'
		|| !Number.isSafeInteger(resultIndexValue) || resultIndexValue < 0) return undefined;
	return Object.freeze({ sourceBoxId, resultIndex: resultIndexValue });
}

export function resultSourceRefKey(value: ResultSourceRef): string {
	const source = createResultSourceRef(value?.sourceBoxId, value?.resultIndex);
	return source ? JSON.stringify([source.sourceBoxId, source.resultIndex]) : '';
}

export function parseResultSourceRefKey(value: unknown): ResultSourceRef | undefined {
	if (typeof value !== 'string' || !value || value.length > 8192) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
		const source = createResultSourceRef(parsed[0], parsed[1]);
		return source && resultSourceRefKey(source) === value ? source : undefined;
	} catch {
		return undefined;
	}
}

export function formatResultSourceLabel(
	baseLabelValue: unknown,
	resultIndex: number,
	resultSetCount: number,
): string {
	const baseLabel = String(baseLabelValue || '');
	return Number.isSafeInteger(resultIndex) && resultIndex >= 0
		&& Number.isSafeInteger(resultSetCount) && resultSetCount > 1
		? `${baseLabel} (Result #${resultIndex + 1})`
		: baseLabel;
}

export const RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT = 'kusto-workbench-result-artifact-consumers-revoked';
export const RESULT_ARTIFACT_CSV_RESET_EVENT = 'kusto-workbench-result-artifact-csv-reset';

export function htmlDashboardFactArtifactConsumerId(htmlBoxId: unknown): string {
	return `html:${String(htmlBoxId || '').trim()}:fact`;
}

export function modelResultArtifactConsumerId(requestId: unknown): string {
	return `model:${String(requestId || '').trim()}:result`;
}

export function shareClipboardArtifactConsumerId(): string {
	return 'share:clipboard:result';
}

export function csvTableArtifactConsumerId(sourceBoxId: unknown): string {
	return `csv:${String(sourceBoxId || '').trim()}:table`;
}

export function diffArtifactConsumerId(side: 'a' | 'b'): string {
	return `diff:modal:${side}`;
}

export function csvSaveArtifactConsumerId(sourceBoxId: unknown): string {
	return `csv:${String(sourceBoxId || '').trim()}:save`;
}

export function comparisonSourceArtifactConsumerId(comparisonBoxId: unknown): string {
	return `comparison:${String(comparisonBoxId || '').trim()}:source`;
}

function cloneValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) return new Date(value.getTime());
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const item of value) clone.push(cloneValue(item, seen));
		return clone;
	}
	const clone: Record<string, unknown> = {};
	seen.set(value, clone);
	for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item, seen);
	return clone;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value;
	seen.add(value);
	for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item, seen);
	return Object.freeze(value);
}

function snapshotRecord<T extends object>(value: T | undefined): Readonly<T> | undefined {
	return value ? deepFreeze(cloneValue(value) as T) : undefined;
}

function snapshotLineage(lineage: readonly ResultArtifactLineage[] | undefined): readonly ResultArtifactLineage[] {
	return deepFreeze((lineage || []).map(item => ({
		sourceArtifactId: String(item.sourceArtifactId || ''),
		...(item.role ? { role: String(item.role) } : {}),
	})).filter(item => !!item.sourceArtifactId));
}

function encodeArtifactSourceId(sourceBoxId: string): string {
	try {
		return encodeURIComponent(sourceBoxId);
	} catch {
		let encoded = '';
		for (let index = 0; index < sourceBoxId.length; index++) {
			encoded += `%u${sourceBoxId.charCodeAt(index).toString(16).padStart(4, '0')}`;
		}
		return encoded;
	}
}

function canonicalResultArtifactId(sourceBoxId: string, revision: number, resultIndex = 0): string {
	const primaryId = `result:${encodeArtifactSourceId(sourceBoxId)}:${revision}`;
	return resultIndex === 0 ? primaryId : `${primaryId}:set:${resultIndex}`;
}

export function createPrimaryResultArtifactIdentity(
	sourceBoxId: unknown,
	revisionValue: unknown,
	createdAtValue: unknown,
): Readonly<{ artifactId: string; sourceBoxId: string; revision: number; createdAt: number }> | undefined {
	const sourceBoxIdText = String(sourceBoxId || '').trim();
	const revision = Number(revisionValue);
	const createdAt = Number(createdAtValue);
	if (!sourceBoxIdText || !Number.isSafeInteger(revision) || revision <= 0
		|| revision >= Number.MAX_SAFE_INTEGER || !Number.isFinite(createdAt) || createdAt < 0) return undefined;
	return Object.freeze({
		artifactId: canonicalResultArtifactId(sourceBoxIdText, revision),
		sourceBoxId: sourceBoxIdText,
		revision,
		createdAt,
	});
}

export function projectRowsToDeclaredColumns(columns: unknown, rows: unknown): unknown[][] {
	const declaredColumns = Array.isArray(columns) ? columns : [];
	const sourceRows = Array.isArray(rows) ? rows : [];
	const width = declaredColumns.length;
	if (sourceRows.every(row => Array.isArray(row) && row.length === width)) {
		return sourceRows as unknown[][];
	}
	return sourceRows.map(row => Array.from(
		{ length: width },
		(_, index) => Array.isArray(row) ? row[index] : undefined,
	));
}

function policyStamp(policy: ResultArtifactPolicy | ResultArtifactSourcePolicy | undefined): ResultArtifactPolicyStamp | undefined {
	if (!policy) return undefined;
	const stamp: Record<string, unknown> = {};
	for (const key of [
		'accountPartition',
		'authSessionGeneration',
		'leaveNoTraceRevision',
		'connectionRevision',
		'connectionIdentityKey',
		'exposeToActiveContent',
		'sendToModel',
		'shareToClipboard',
		'exportToCsv',
	] as const) {
		if (policy[key] !== undefined) stamp[key] = policy[key];
	}
	return Object.keys(stamp).length ? stamp as ResultArtifactPolicyStamp : undefined;
}

function sourcePoliciesForArtifact(artifact: ResultArtifact): ResultArtifactSourcePolicy[] {
	const inherited = artifact.policy?.sourcePolicies;
	if (inherited?.length) {
		return inherited.map(sourcePolicy => ({
			sourceArtifactId: sourcePolicy.sourceArtifactId,
			...policyStamp(sourcePolicy),
		}));
	}
	const stamp = policyStamp(artifact.policy);
	return [{ sourceArtifactId: artifact.artifactId, ...stamp }];
}

export function createDerivedResultArtifactPublication(
	producer: ResultArtifactProducer,
	inputs: readonly DerivedResultArtifactInput[],
): ResultArtifactPublication {
	const validInputs = inputs.filter(input => !!String(input.artifact?.artifactId || '').trim());
	const lineage = snapshotLineage(validInputs.map(input => ({
		sourceArtifactId: input.artifact.artifactId,
		...(input.role ? { role: input.role } : {}),
	})));
	const sourcePoliciesByKey = new Map<string, ResultArtifactSourcePolicy>();
	for (const input of validInputs) {
		for (const sourcePolicy of sourcePoliciesForArtifact(input.artifact)) {
			const stamp = policyStamp(sourcePolicy);
			const key = `${sourcePolicy.sourceArtifactId}\u0000${JSON.stringify(stamp || {})}`;
			sourcePoliciesByKey.set(key, { sourceArtifactId: sourcePolicy.sourceArtifactId, ...stamp });
		}
	}
	const sourcePolicies = [...sourcePoliciesByKey.values()];
	const firstStamp = sourcePolicies.length ? policyStamp(sourcePolicies[0]) : undefined;
	const commonStamp = firstStamp && sourcePolicies.every(sourcePolicy => (
		JSON.stringify(policyStamp(sourcePolicy) || {}) === JSON.stringify(firstStamp)
	)) ? firstStamp : undefined;
	const allSourcesAllowActiveContent = sourcePolicies.length > 0
		&& sourcePolicies.every(sourcePolicy => sourcePolicy.exposeToActiveContent === true);
	const allSourcesAllowModelUse = sourcePolicies.length > 0
		&& sourcePolicies.every(sourcePolicy => sourcePolicy.sendToModel === true);
	const allSourcesAllowClipboardShare = sourcePolicies.length > 0
		&& sourcePolicies.every(sourcePolicy => sourcePolicy.shareToClipboard === true);
	const allSourcesAllowCsvExport = sourcePolicies.length > 0
		&& sourcePolicies.every(sourcePolicy => sourcePolicy.exportToCsv === true);
	const policy = sourcePolicies.length
		? deepFreeze({
			...commonStamp,
			...(allSourcesAllowActiveContent ? { exposeToActiveContent: true } : {}),
			...(allSourcesAllowModelUse ? { sendToModel: true } : {}),
			...(allSourcesAllowClipboardShare ? { shareToClipboard: true } : {}),
			...(allSourcesAllowCsvExport ? { exportToCsv: true } : {}),
			sourcePolicies: deepFreeze(sourcePolicies),
		})
		: undefined;
	return deepFreeze({
		producer: snapshotRecord(producer)!,
		lineage,
		...(policy ? { policy } : {}),
	});
}

export function createRestoredKustoResultArtifactPublication(
	producer: ResultArtifactProducer,
	accountPartition: unknown,
	leaveNoTraceRevision: unknown,
): ResultArtifactPublication | undefined {
	const partition = String(accountPartition || '').trim();
	const revision = Number(leaveNoTraceRevision);
	if (!partition || !Number.isSafeInteger(revision) || revision < 0) return undefined;
	return deepFreeze({
		producer: snapshotRecord(producer)!,
		policy: deepFreeze({ accountPartition: partition, leaveNoTraceRevision: revision }),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePersistedPolicyStamp(value: Record<string, unknown>): ResultArtifactPolicyStamp | null {
	const stamp: Record<string, unknown> = {};
	for (const key of ['accountPartition', 'connectionIdentityKey'] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== 'string') return null;
		const text = value[key].trim();
		if (!text || text.length > 2048) return null;
		stamp[key] = text;
	}
	for (const key of ['authSessionGeneration', 'leaveNoTraceRevision', 'connectionRevision'] as const) {
		if (value[key] === undefined) continue;
		const number = Number(value[key]);
		if (!Number.isSafeInteger(number) || number < 0) return null;
		stamp[key] = number;
	}
	for (const key of ['exposeToActiveContent', 'sendToModel', 'shareToClipboard', 'exportToCsv'] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== 'boolean') return null;
		stamp[key] = value[key];
	}
	return stamp as ResultArtifactPolicyStamp;
}

function parsePersistedPolicy(value: Record<string, unknown>): ResultArtifactPolicy | null {
	const stamp = parsePersistedPolicyStamp(value);
	if (!stamp) return null;
	if (value.sourcePolicies === undefined) return stamp;
	if (!Array.isArray(value.sourcePolicies) || value.sourcePolicies.length === 0
		|| value.sourcePolicies.length > 1024) return null;
	const sourcePolicies: ResultArtifactSourcePolicy[] = [];
	const sourceArtifactIds = new Set<string>();
	for (const item of value.sourcePolicies) {
		if (!isRecord(item)) return null;
		const sourceArtifactId = String(item.sourceArtifactId || '').trim();
		const sourceStamp = parsePersistedPolicyStamp(item);
		if (!sourceArtifactId || sourceArtifactId.length > 512 || !sourceStamp
			|| sourceArtifactIds.has(sourceArtifactId)) return null;
		sourceArtifactIds.add(sourceArtifactId);
		sourcePolicies.push({ sourceArtifactId, ...sourceStamp });
	}
	return { ...stamp, sourcePolicies };
}

export function toPersistedResultArtifact(artifact: ResultArtifact | null | undefined): PersistedResultArtifactV1 | undefined {
	if (!artifact || artifact.resultIndex !== 0) return undefined;
	return deepFreeze({
		version: 1,
		artifactId: artifact.artifactId,
		sourceBoxId: artifact.sourceBoxId,
		revision: artifact.revision,
		createdAt: artifact.createdAt,
		...(artifact.producer ? { producer: snapshotRecord(artifact.producer)! } : {}),
		...(artifact.policy ? { policy: snapshotRecord(artifact.policy)! } : {}),
		...(artifact.lineage.length ? { lineage: snapshotLineage(artifact.lineage) } : {}),
	});
}

export function publicationFromPersistedResultArtifact(
	value: unknown,
	expectedSourceBoxId: string,
	expectedPolicy?: Readonly<{
		accountPartition?: unknown;
		leaveNoTraceRevision?: unknown;
		exposeToActiveContent?: unknown;
		sendToModel?: unknown;
		shareToClipboard?: unknown;
		exportToCsv?: unknown;
		expectedProducer?: Readonly<{
			engine?: unknown;
			query?: unknown;
			connectionId?: unknown;
			database?: unknown;
		}>;
		derivedLineage?: readonly ResultArtifactLineage[];
		derivedSourcePolicies?: readonly ResultArtifactSourcePolicy[];
	}>,
): ResultArtifactPublication | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const artifactId = String(value.artifactId || '').trim();
	const sourceBoxId = String(value.sourceBoxId || '').trim();
	const expectedSource = String(expectedSourceBoxId || '').trim();
	const revision = Number(value.revision);
	const createdAt = Number(value.createdAt);
	if (!artifactId || artifactId.length > 512 || !sourceBoxId || sourceBoxId !== expectedSource
		|| !Number.isSafeInteger(revision) || revision <= 0 || revision >= Number.MAX_SAFE_INTEGER
		|| artifactId !== canonicalResultArtifactId(sourceBoxId, revision)
		|| !Number.isFinite(createdAt) || createdAt < 0) return undefined;
	const producer = isRecord(value.producer) ? value.producer as ResultArtifactProducer : undefined;
	if (producer && String(producer.boxId || '').trim() !== expectedSource) return undefined;
	if (expectedPolicy?.expectedProducer) {
		if (!producer) return undefined;
		const expectedProducer = expectedPolicy.expectedProducer;
		if (expectedProducer.engine !== undefined
			&& String(producer.engine || '').trim() !== String(expectedProducer.engine || '').trim()) return undefined;
		if (expectedProducer.query !== undefined
			&& String(producer.query ?? '') !== String(expectedProducer.query ?? '')) return undefined;
		if (expectedProducer.connectionId !== undefined
			&& String(producer.connectionId || '').trim() !== String(expectedProducer.connectionId || '').trim()) return undefined;
		if (expectedProducer.database !== undefined
			&& String(producer.database || '').trim().toLowerCase()
				!== String(expectedProducer.database || '').trim().toLowerCase()) return undefined;
	}
	let lineage: ResultArtifactLineage[] | undefined;
	if (value.lineage !== undefined) {
		if (!Array.isArray(value.lineage) || value.lineage.length > 1024) return undefined;
		lineage = [];
		for (const item of value.lineage) {
			if (!isRecord(item)) return undefined;
			const sourceArtifactId = String(item.sourceArtifactId || '').trim();
			const role = String(item.role || '').trim();
			if (!sourceArtifactId || sourceArtifactId.length > 512 || role.length > 512) return undefined;
			lineage.push({ sourceArtifactId, ...(role ? { role } : {}) });
		}
		if (lineage.length === 0) lineage = undefined;
	}
	const policy = isRecord(value.policy) ? parsePersistedPolicy(value.policy) : undefined;
	if (isRecord(value.policy) && !policy) return undefined;
	if (expectedPolicy && !policy) return undefined;
	const hasPersistedDerivation = !!lineage?.length || !!policy?.sourcePolicies?.length;
	if (hasPersistedDerivation && expectedPolicy?.derivedLineage === undefined) return undefined;
	if (expectedPolicy?.derivedLineage !== undefined) {
		const expectedLineage = snapshotLineage(expectedPolicy.derivedLineage);
		const expectedSourcePolicies = expectedPolicy.derivedSourcePolicies?.map(sourcePolicy => ({
			sourceArtifactId: String(sourcePolicy.sourceArtifactId || '').trim(),
			...policyStamp(sourcePolicy),
		})) || [];
		const actualSourcePolicies = policy?.sourcePolicies || [];
		const sourcePoliciesMatch = actualSourcePolicies.length === expectedSourcePolicies.length
			&& actualSourcePolicies.every((sourcePolicy, index) => (
				sourcePolicy.sourceArtifactId === expectedSourcePolicies[index]?.sourceArtifactId
				&& JSON.stringify(policyStamp(sourcePolicy) || {})
					=== JSON.stringify(policyStamp(expectedSourcePolicies[index]) || {})
			));
		if (expectedLineage.length === 0 || expectedSourcePolicies.length === 0
			|| JSON.stringify(lineage || []) !== JSON.stringify(expectedLineage)
			|| !sourcePoliciesMatch) {
			return undefined;
		}
	}
	if (policy) {
		const partition = policy.accountPartition || '';
		const leaveNoTraceRevision = policy.leaveNoTraceRevision;
		const expectedPartition = expectedPolicy?.accountPartition === undefined
			? ''
			: String(expectedPolicy.accountPartition || '').trim();
		const expectedRevision = expectedPolicy?.leaveNoTraceRevision === undefined
			? undefined
			: Number(expectedPolicy.leaveNoTraceRevision);
		if (expectedPartition && partition !== expectedPartition) return undefined;
		if (expectedRevision !== undefined && leaveNoTraceRevision !== expectedRevision) return undefined;
		if (expectedPolicy?.exposeToActiveContent !== undefined
			&& policy.exposeToActiveContent !== expectedPolicy.exposeToActiveContent) return undefined;
		if (expectedPolicy?.sendToModel !== undefined
			&& policy.sendToModel !== expectedPolicy.sendToModel) return undefined;
		if (expectedPolicy?.shareToClipboard !== undefined
			&& policy.shareToClipboard !== expectedPolicy.shareToClipboard) return undefined;
		if (expectedPolicy?.exportToCsv !== undefined
			&& policy.exportToCsv !== expectedPolicy.exportToCsv) return undefined;
		if (policy.exposeToActiveContent === true && expectedPolicy?.exposeToActiveContent !== true) return undefined;
		if (policy.sendToModel === true && expectedPolicy?.sendToModel !== true) return undefined;
		if (policy.shareToClipboard === true && expectedPolicy?.shareToClipboard !== true) return undefined;
		if (policy.exportToCsv === true && expectedPolicy?.exportToCsv !== true) return undefined;
		if (policy.sourcePolicies?.length) {
			if (!lineage?.length) return undefined;
			if (policy.exposeToActiveContent === true
				&& !policy.sourcePolicies.every(source => source.exposeToActiveContent === true)) return undefined;
			if (policy.sendToModel === true
				&& !policy.sourcePolicies.every(source => source.sendToModel === true)) return undefined;
			if (policy.shareToClipboard === true
				&& !policy.sourcePolicies.every(source => source.shareToClipboard === true)) return undefined;
			if (policy.exportToCsv === true
				&& !policy.sourcePolicies.every(source => source.exportToCsv === true)) return undefined;
			if (policy.sourcePolicies.some(source => source.exposeToActiveContent === true)
				&& expectedPolicy?.exposeToActiveContent !== true) return undefined;
			if (policy.sourcePolicies.some(source => source.sendToModel === true)
				&& expectedPolicy?.sendToModel !== true) return undefined;
			if (policy.sourcePolicies.some(source => source.shareToClipboard === true)
				&& expectedPolicy?.shareToClipboard !== true) return undefined;
			if (policy.sourcePolicies.some(source => source.exportToCsv === true)
				&& expectedPolicy?.exportToCsv !== true) return undefined;
		} else if (lineage?.length
			&& (policy.exposeToActiveContent === true || policy.sendToModel === true
				|| policy.shareToClipboard === true || policy.exportToCsv === true)) {
			return undefined;
		}
	}
	return {
		...(producer ? { producer } : {}),
		...(policy ? { policy } : {}),
		...(lineage?.length ? { lineage } : {}),
		persistedIdentity: { artifactId, sourceBoxId, revision, createdAt },
	};
}

export type ResultArtifactStoreSnapshot = Readonly<{
	artifacts: readonly (readonly [string, ResultArtifact])[];
	currentArtifactIds: readonly (readonly [string, string])[];
	currentIndexedArtifactIds?: readonly (readonly [string, number, string])[];
	nextRevisions: readonly (readonly [string, number])[];
	consumerArtifactIds: readonly (readonly [string, string])[];
}>;

export class ResultArtifactStore {
	private readonly artifacts = new Map<string, ResultArtifact>();
	private readonly currentArtifactIdBySourceResult = new Map<string, string>();
	private readonly nextRevisionBySource = new Map<string, number>();
	private readonly artifactIdByConsumer = new Map<string, string>();

	private sourceResultKey(sourceBoxId: string, resultIndex: number): string {
		return JSON.stringify([sourceBoxId, resultIndex]);
	}

	publish(
		sourceBoxId: string,
		state: { columns?: unknown; rows?: unknown; metadata?: unknown },
		publication: ResultArtifactPublication = {},
	): ResultArtifact | undefined {
		return this.publishBatch(sourceBoxId, [{ resultIndex: 0, ...state }], publication)?.[0];
	}

	publishBatch(
		sourceBoxId: string,
		states: readonly Readonly<{
			resultIndex: number;
			columns?: unknown;
			rows?: unknown;
			metadata?: unknown;
		}>[],
		publication: ResultArtifactPublication = {},
	): readonly ResultArtifact[] | undefined {
		const sourceId = String(sourceBoxId || '').trim();
		if (!sourceId || !Array.isArray(states) || states.length === 0 || states.length > 256) return undefined;
		for (let resultIndex = 0; resultIndex < states.length; resultIndex++) {
			if (states[resultIndex]?.resultIndex !== resultIndex) return undefined;
		}
		const previousRevision = this.nextRevisionBySource.get(sourceId) || 0;
		const persisted = publication.persistedIdentity;
		const assigned = publication.assignedIdentity;
		if (persisted && assigned) return undefined;
		const canAssignIdentity = !!assigned
			&& assigned.sourceBoxId === sourceId
			&& Number.isSafeInteger(assigned.revision)
			&& assigned.revision > previousRevision
			&& assigned.revision < Number.MAX_SAFE_INTEGER
			&& Number.isFinite(assigned.createdAt)
			&& assigned.createdAt >= 0
			&& assigned.artifactId === canonicalResultArtifactId(sourceId, assigned.revision)
			&& !states.some(state => this.artifacts.has(
				canonicalResultArtifactId(sourceId, assigned.revision, state.resultIndex),
			));
		if (assigned && !canAssignIdentity) return undefined;
		const canRestoreIdentity = !!persisted
			&& persisted.sourceBoxId === sourceId
			&& Number.isSafeInteger(persisted.revision)
			&& persisted.revision > 0
			&& persisted.revision < Number.MAX_SAFE_INTEGER
			&& persisted.artifactId === canonicalResultArtifactId(sourceId, persisted.revision)
			&& !states.some(state => this.currentArtifactIdBySourceResult.has(
				this.sourceResultKey(sourceId, state.resultIndex),
			))
			&& !states.some(state => this.artifacts.has(
				canonicalResultArtifactId(sourceId, persisted.revision, state.resultIndex),
			));
		const nextRevision = previousRevision + 1;
		if (!canRestoreIdentity && !canAssignIdentity
			&& (!Number.isSafeInteger(nextRevision) || nextRevision <= previousRevision)) return undefined;
		let revision = canAssignIdentity ? assigned!.revision : canRestoreIdentity ? persisted!.revision : nextRevision;
		let artifactIds = states.map(state => canonicalResultArtifactId(sourceId, revision, state.resultIndex));
		while (!canRestoreIdentity && !canAssignIdentity && artifactIds.some(artifactId => this.artifacts.has(artifactId))) {
			if (revision >= Number.MAX_SAFE_INTEGER) return undefined;
			revision++;
			artifactIds = states.map(state => canonicalResultArtifactId(sourceId, revision, state.resultIndex));
		}
		const createdAt = canAssignIdentity ? assigned!.createdAt : canRestoreIdentity ? persisted!.createdAt : Date.now();
		let artifacts: ResultArtifact[];
		try {
			artifacts = states.map((state, index) => {
				const columns = deepFreeze(cloneValue(Array.isArray(state.columns) ? state.columns : []) as unknown[]);
				const rows = deepFreeze(cloneValue(projectRowsToDeclaredColumns(columns, state.rows)) as unknown[]);
				const metadataValue = state.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata)
					? state.metadata as Record<string, unknown>
					: {};
				return Object.freeze({
					artifactId: artifactIds[index],
					sourceBoxId: sourceId,
					resultIndex: state.resultIndex,
					revision,
					createdAt,
					restored: canRestoreIdentity,
					columns,
					rows,
					metadata: deepFreeze(cloneValue(metadataValue) as Record<string, unknown>),
					...(publication.producer ? { producer: snapshotRecord(publication.producer)! } : {}),
					...(publication.policy ? { policy: snapshotRecord(publication.policy)! } : {}),
					lineage: snapshotLineage(publication.lineage),
				});
			});
		} catch {
			return undefined;
		}
		const previousArtifactIds = [...this.currentArtifactIdBySourceResult.values()].filter(artifactId =>
			this.artifacts.get(artifactId)?.sourceBoxId === sourceId
		);
		this.nextRevisionBySource.set(sourceId, Math.max(previousRevision, revision));
		for (const [key, artifactId] of [...this.currentArtifactIdBySourceResult]) {
			if (this.artifacts.get(artifactId)?.sourceBoxId === sourceId) {
				this.currentArtifactIdBySourceResult.delete(key);
			}
		}
		for (const artifact of artifacts) {
			this.artifacts.set(artifact.artifactId, artifact);
			this.currentArtifactIdBySourceResult.set(
				this.sourceResultKey(sourceId, artifact.resultIndex), artifact.artifactId,
			);
		}
		for (const artifactId of previousArtifactIds) this.pruneIfUnreferenced(artifactId);
		return Object.freeze(artifacts);
	}

	get(artifactId: string): ResultArtifact | undefined {
		return this.artifacts.get(String(artifactId || '').trim());
	}

	getCurrent(sourceBoxId: string, resultIndex = 0): ResultArtifact | undefined {
		const source = String(sourceBoxId || '').trim();
		if (!Number.isSafeInteger(resultIndex) || resultIndex < 0) return undefined;
		const artifactId = this.currentArtifactIdBySourceResult.get(this.sourceResultKey(source, resultIndex));
		const artifact = artifactId ? this.artifacts.get(artifactId) : undefined;
		return artifact?.sourceBoxId === source && artifact.resultIndex === resultIndex ? artifact : undefined;
	}

	getByProducerExecution(sourceBoxId: string, executionId: string, resultIndex = 0): ResultArtifact | undefined {
		const source = String(sourceBoxId || '').trim();
		const execution = String(executionId || '').trim();
		if (!source || !execution || !Number.isSafeInteger(resultIndex) || resultIndex < 0) return undefined;
		const current = this.getCurrent(source, resultIndex);
		if (current?.producer?.executionId === execution) return current;
		return [...this.artifacts.values()]
			.filter(artifact => artifact.sourceBoxId === source
				&& artifact.resultIndex === resultIndex
				&& artifact.producer?.executionId === execution)
			.sort((left, right) => right.revision - left.revision)[0];
	}

	bind(consumerId: string, sourceBoxId: string, artifactId?: string): string | undefined {
		return this.bindIndexed(consumerId, sourceBoxId, 0, artifactId);
	}

	bindIndexed(
		consumerId: string,
		sourceBoxId: string,
		resultIndex: number,
		artifactId?: string,
	): string | undefined {
		const consumer = String(consumerId || '').trim();
		const source = String(sourceBoxId || '').trim();
		if (!consumer || !source || !Number.isSafeInteger(resultIndex) || resultIndex < 0) return undefined;
		const artifact = artifactId ? this.get(artifactId) : this.getCurrent(source, resultIndex);
		if (!artifact || artifact.sourceBoxId !== source || artifact.resultIndex !== resultIndex) return undefined;
		const previousArtifactId = this.artifactIdByConsumer.get(consumer);
		this.artifactIdByConsumer.set(consumer, artifact.artifactId);
		if (previousArtifactId && previousArtifactId !== artifact.artifactId) this.pruneIfUnreferenced(previousArtifactId);
		return artifact.artifactId;
	}

	getBound(consumerId: string, sourceBoxId?: string): ResultArtifact | undefined {
		const artifactId = this.artifactIdByConsumer.get(String(consumerId || '').trim());
		const artifact = artifactId ? this.artifacts.get(artifactId) : undefined;
		if (!artifact) return undefined;
		const source = String(sourceBoxId || '').trim();
		return !source || artifact.sourceBoxId === source ? artifact : undefined;
	}

	unbind(consumerId: string): void {
		const consumer = String(consumerId || '').trim();
		const artifactId = this.artifactIdByConsumer.get(consumer);
		if (!artifactId) return;
		this.artifactIdByConsumer.delete(consumer);
		this.pruneIfUnreferenced(artifactId);
	}

	unbindSource(sourceBoxId: string): void {
		const source = String(sourceBoxId || '').trim();
		if (!source) return;
		const releasedArtifactIds = new Set<string>();
		for (const [consumerId, artifactId] of this.artifactIdByConsumer) {
			const artifact = this.artifacts.get(artifactId);
			if (artifact?.sourceBoxId !== source) continue;
			this.artifactIdByConsumer.delete(consumerId);
			releasedArtifactIds.add(artifactId);
		}
		for (const artifactId of releasedArtifactIds) this.pruneIfUnreferenced(artifactId);
	}

	clearCurrent(sourceBoxId: string, resultIndex = 0): void {
		const source = String(sourceBoxId || '').trim();
		if (!Number.isSafeInteger(resultIndex) || resultIndex < 0) return;
		const key = this.sourceResultKey(source, resultIndex);
		const artifactId = this.currentArtifactIdBySourceResult.get(key);
		if (!artifactId) return;
		this.currentArtifactIdBySourceResult.delete(key);
		this.pruneIfUnreferenced(artifactId);
	}

	clearCurrentBatch(sourceBoxId: string): void {
		const source = String(sourceBoxId || '').trim();
		if (!source) return;
		const released: string[] = [];
		for (const [key, artifactId] of [...this.currentArtifactIdBySourceResult]) {
			if (this.artifacts.get(artifactId)?.sourceBoxId !== source) continue;
			this.currentArtifactIdBySourceResult.delete(key);
			released.push(artifactId);
		}
		for (const artifactId of released) this.pruneIfUnreferenced(artifactId);
	}

	revokeSource(sourceBoxId: string): Readonly<{
		affectedSourceIds: readonly string[];
		revokedConsumerIds: readonly string[];
	}> {
		const source = String(sourceBoxId || '').trim();
		if (!source) return { affectedSourceIds: [], revokedConsumerIds: [] };
		const revokedArtifactIds = new Set(
			[...this.artifacts.values()]
				.filter(artifact => artifact.sourceBoxId === source)
				.map(artifact => artifact.artifactId),
		);
		let changed = true;
		while (changed) {
			changed = false;
			for (const artifact of this.artifacts.values()) {
				if (revokedArtifactIds.has(artifact.artifactId)) continue;
				if (!artifact.lineage.some(input => revokedArtifactIds.has(input.sourceArtifactId))) continue;
				revokedArtifactIds.add(artifact.artifactId);
				changed = true;
			}
		}
		const affectedSourceIds = new Set<string>([source]);
		for (const artifactId of revokedArtifactIds) {
			const artifact = this.artifacts.get(artifactId);
			if (artifact) affectedSourceIds.add(artifact.sourceBoxId);
		}
		for (const [candidateSourceId, currentArtifactId] of this.currentArtifactIdBySourceResult) {
			if (!revokedArtifactIds.has(currentArtifactId)) continue;
			this.currentArtifactIdBySourceResult.delete(candidateSourceId);
		}
		const revokedConsumerIds: string[] = [];
		for (const [consumerId, artifactId] of this.artifactIdByConsumer) {
			if (!revokedArtifactIds.has(artifactId)) continue;
			this.artifactIdByConsumer.delete(consumerId);
			revokedConsumerIds.push(consumerId);
		}
		const lineageCandidates = new Set<string>();
		for (const artifactId of revokedArtifactIds) {
			const artifact = this.artifacts.get(artifactId);
			if (!artifact) continue;
			for (const input of artifact.lineage) lineageCandidates.add(input.sourceArtifactId);
			this.artifacts.delete(artifactId);
		}
		for (const artifactId of lineageCandidates) {
			if (!revokedArtifactIds.has(artifactId)) this.pruneIfUnreferenced(artifactId);
		}
		return {
			affectedSourceIds: [...affectedSourceIds],
			revokedConsumerIds,
		};
	}

	clear(): void {
		this.artifacts.clear();
		this.currentArtifactIdBySourceResult.clear();
		this.nextRevisionBySource.clear();
		this.artifactIdByConsumer.clear();
	}

	captureSnapshot(): ResultArtifactStoreSnapshot {
		const currentArtifacts = [...this.currentArtifactIdBySourceResult.values()]
			.map(artifactId => this.artifacts.get(artifactId))
			.filter((artifact): artifact is ResultArtifact => !!artifact);
		return {
			artifacts: [...this.artifacts.entries()],
			currentArtifactIds: currentArtifacts
				.filter(artifact => artifact.resultIndex === 0)
				.map(artifact => [artifact.sourceBoxId, artifact.artifactId] as const),
			currentIndexedArtifactIds: currentArtifacts.map(artifact => [
				artifact.sourceBoxId, artifact.resultIndex, artifact.artifactId,
			] as const),
			nextRevisions: [...this.nextRevisionBySource.entries()],
			consumerArtifactIds: [...this.artifactIdByConsumer.entries()],
		};
	}

	restoreSnapshot(snapshot: ResultArtifactStoreSnapshot): void {
		this.clear();
		for (const [artifactId, artifact] of snapshot.artifacts) this.artifacts.set(artifactId, artifact);
		const indexed = snapshot.currentIndexedArtifactIds ?? snapshot.currentArtifactIds.map(
			([sourceBoxId, artifactId]) => [sourceBoxId, 0, artifactId] as const,
		);
		for (const [sourceBoxId, resultIndex, artifactId] of indexed) {
			this.currentArtifactIdBySourceResult.set(this.sourceResultKey(sourceBoxId, resultIndex), artifactId);
		}
		for (const [sourceBoxId, revision] of snapshot.nextRevisions) {
			this.nextRevisionBySource.set(sourceBoxId, revision);
		}
		for (const [consumerId, artifactId] of snapshot.consumerArtifactIds) {
			this.artifactIdByConsumer.set(consumerId, artifactId);
		}
	}

	private pruneIfUnreferenced(artifactId: string, visited = new Set<string>()): void {
		if (visited.has(artifactId)) return;
		visited.add(artifactId);
		if ([...this.currentArtifactIdBySourceResult.values()].includes(artifactId)) return;
		if ([...this.artifactIdByConsumer.values()].includes(artifactId)) return;
		if ([...this.artifacts.values()].some(artifact => (
			artifact.artifactId !== artifactId
			&& artifact.lineage.some(input => input.sourceArtifactId === artifactId)
		))) return;
		const artifact = this.artifacts.get(artifactId);
		this.artifacts.delete(artifactId);
		for (const input of artifact?.lineage || []) this.pruneIfUnreferenced(input.sourceArtifactId, visited);
	}
}
