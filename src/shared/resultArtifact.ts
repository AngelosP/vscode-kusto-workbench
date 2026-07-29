export type ResultArtifactProducer = Readonly<{
	engine?: string;
	boxId: string;
	executionId?: string;
	sectionInstanceId?: string;
	targetGeneration?: number;
	reservationSequence?: number;
	connectionId?: string;
	database?: string;
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

export const RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT = 'kusto-workbench-result-artifact-consumers-revoked';

export function htmlDashboardFactArtifactConsumerId(htmlBoxId: unknown): string {
	return `html:${String(htmlBoxId || '').trim()}:fact`;
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
	return stamp ? [{ sourceArtifactId: artifact.artifactId, ...stamp }] : [];
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
	const policy = sourcePolicies.length
		? deepFreeze({
			...commonStamp,
			...(allSourcesAllowActiveContent ? { exposeToActiveContent: true } : {}),
			sourcePolicies: deepFreeze(sourcePolicies),
		})
		: undefined;
	return deepFreeze({
		producer: snapshotRecord(producer)!,
		lineage,
		...(policy ? { policy } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function toPersistedResultArtifact(artifact: ResultArtifact | null | undefined): PersistedResultArtifactV1 | undefined {
	if (!artifact) return undefined;
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
	}>,
): ResultArtifactPublication | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const artifactId = String(value.artifactId || '').trim();
	const sourceBoxId = String(value.sourceBoxId || '').trim();
	const expectedSource = String(expectedSourceBoxId || '').trim();
	const revision = Number(value.revision);
	const createdAt = Number(value.createdAt);
	if (!artifactId || artifactId.length > 512 || !sourceBoxId || sourceBoxId !== expectedSource
		|| !Number.isSafeInteger(revision) || revision <= 0
		|| !Number.isFinite(createdAt) || createdAt < 0) return undefined;
	const producer = isRecord(value.producer) ? value.producer as ResultArtifactProducer : undefined;
	if (producer && String(producer.boxId || '').trim() !== expectedSource) return undefined;
	const policy = isRecord(value.policy) ? value.policy as ResultArtifactPolicy : undefined;
	if (expectedPolicy && !policy) return undefined;
	if (policy) {
		const partition = policy.accountPartition === undefined ? '' : String(policy.accountPartition || '').trim();
		const leaveNoTraceRevision = policy.leaveNoTraceRevision === undefined ? undefined : Number(policy.leaveNoTraceRevision);
		if (policy.accountPartition !== undefined && !partition) return undefined;
		if (leaveNoTraceRevision !== undefined && (!Number.isSafeInteger(leaveNoTraceRevision) || leaveNoTraceRevision < 0)) return undefined;
		if (policy.exposeToActiveContent !== undefined && typeof policy.exposeToActiveContent !== 'boolean') return undefined;
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
	}
	const lineage = Array.isArray(value.lineage)
		? value.lineage.filter(isRecord).map(item => ({
			sourceArtifactId: String(item.sourceArtifactId || '').trim().slice(0, 512),
			...(String(item.role || '').trim() ? { role: String(item.role || '').trim() } : {}),
		})).filter(item => !!item.sourceArtifactId)
		: undefined;
	return {
		...(producer ? { producer } : {}),
		...(policy ? { policy } : {}),
		...(lineage?.length ? { lineage } : {}),
		persistedIdentity: { artifactId, sourceBoxId, revision, createdAt },
	};
}

export class ResultArtifactStore {
	private readonly artifacts = new Map<string, ResultArtifact>();
	private readonly currentArtifactIdBySource = new Map<string, string>();
	private readonly nextRevisionBySource = new Map<string, number>();
	private readonly artifactIdByConsumer = new Map<string, string>();

	publish(
		sourceBoxId: string,
		state: { columns?: unknown; rows?: unknown; metadata?: unknown },
		publication: ResultArtifactPublication = {},
	): ResultArtifact | undefined {
		const sourceId = String(sourceBoxId || '').trim();
		if (!sourceId) return undefined;
		const previousRevision = this.nextRevisionBySource.get(sourceId) || 0;
		const nextRevision = previousRevision + 1;
		const persisted = publication.persistedIdentity;
		const canRestoreIdentity = !!persisted
			&& persisted.sourceBoxId === sourceId
			&& !this.currentArtifactIdBySource.has(sourceId)
			&& !this.artifacts.has(persisted.artifactId);
		const revision = canRestoreIdentity ? persisted!.revision : nextRevision;
		const artifactId = canRestoreIdentity
			? persisted!.artifactId
			: `result:${encodeURIComponent(sourceId)}:${revision}`;
		this.nextRevisionBySource.set(sourceId, Math.max(previousRevision, revision));
		const previousArtifactId = this.currentArtifactIdBySource.get(sourceId);
		const columns = deepFreeze(cloneValue(Array.isArray(state.columns) ? state.columns : []) as unknown[]);
		const rows = deepFreeze(cloneValue(Array.isArray(state.rows) ? state.rows : []) as unknown[]);
		const metadataValue = state.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata)
			? state.metadata as Record<string, unknown>
			: {};
		const artifact: ResultArtifact = Object.freeze({
			artifactId,
			sourceBoxId: sourceId,
			revision,
			createdAt: canRestoreIdentity ? persisted!.createdAt : Date.now(),
			restored: canRestoreIdentity,
			columns,
			rows,
			metadata: deepFreeze(cloneValue(metadataValue) as Record<string, unknown>),
			...(publication.producer ? { producer: snapshotRecord(publication.producer)! } : {}),
			...(publication.policy ? { policy: snapshotRecord(publication.policy)! } : {}),
			lineage: snapshotLineage(publication.lineage),
		});
		this.artifacts.set(artifactId, artifact);
		this.currentArtifactIdBySource.set(sourceId, artifactId);
		if (previousArtifactId) this.pruneIfUnreferenced(previousArtifactId);
		return artifact;
	}

	get(artifactId: string): ResultArtifact | undefined {
		return this.artifacts.get(String(artifactId || '').trim());
	}

	getCurrent(sourceBoxId: string): ResultArtifact | undefined {
		const artifactId = this.currentArtifactIdBySource.get(String(sourceBoxId || '').trim());
		return artifactId ? this.artifacts.get(artifactId) : undefined;
	}

	getByProducerExecution(sourceBoxId: string, executionId: string): ResultArtifact | undefined {
		const source = String(sourceBoxId || '').trim();
		const execution = String(executionId || '').trim();
		if (!source || !execution) return undefined;
		return [...this.artifacts.values()].find(artifact => (
			artifact.sourceBoxId === source && artifact.producer?.executionId === execution
		));
	}

	bind(consumerId: string, sourceBoxId: string, artifactId?: string): string | undefined {
		const consumer = String(consumerId || '').trim();
		const source = String(sourceBoxId || '').trim();
		if (!consumer || !source) return undefined;
		const artifact = artifactId ? this.get(artifactId) : this.getCurrent(source);
		if (!artifact || artifact.sourceBoxId !== source) return undefined;
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

	clearCurrent(sourceBoxId: string): void {
		const source = String(sourceBoxId || '').trim();
		const artifactId = this.currentArtifactIdBySource.get(source);
		if (!artifactId) return;
		this.currentArtifactIdBySource.delete(source);
		this.pruneIfUnreferenced(artifactId);
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
		for (const [candidateSourceId, currentArtifactId] of this.currentArtifactIdBySource) {
			if (!revokedArtifactIds.has(currentArtifactId)) continue;
			this.currentArtifactIdBySource.delete(candidateSourceId);
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
		this.currentArtifactIdBySource.clear();
		this.nextRevisionBySource.clear();
		this.artifactIdByConsumer.clear();
	}

	private pruneIfUnreferenced(artifactId: string, visited = new Set<string>()): void {
		if (visited.has(artifactId)) return;
		visited.add(artifactId);
		if ([...this.currentArtifactIdBySource.values()].includes(artifactId)) return;
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
