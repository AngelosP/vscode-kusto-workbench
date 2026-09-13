import {
	createDerivedResultArtifactPublication,
	createPrimaryResultArtifactIdentity,
	UNVERIFIED_LEGACY_RESULT_PRODUCER,
	type PersistedResultArtifactV1,
	type ResultArtifact,
	type ResultArtifactPolicy,
	type ResultArtifactProducer,
} from '../shared/resultArtifact.js';
import {
	getKustoResultSets,
	parseKustoResultBatch,
	serializeKustoResultBatchForPersistence,
	type KustoResultBatchV1,
} from '../shared/kustoResultBatch.js';
import {
	hasKustoExecutionReservation,
	hasKustoExecutionTerminalStamp,
	kustoExecutionIdentityEquals,
	type KustoExecutionTerminalStamp,
	type KustoExecutionRequestIdentity,
	type KustoSectionLifecycleOwner,
} from '../shared/kustoExecution.js';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities.js';
import { kustoClusterKey } from '../shared/kustoClusterUrls.js';
import { getKustoConnectionIdentityKey } from '../shared/kustoAuth.js';
import {
	legacyKustoTargetMatchesRecord,
	resolveLegacyKustoEffectiveTarget,
} from '../shared/legacyKustoResult.js';
import type { KustoExecutionTerminal } from './kustoExecutionCoordinator.js';

type JsonRecord = Record<string, unknown>;
type ResultState = { sections?: unknown[] };
type KustoResultTerminal = Extract<KustoExecutionTerminal, Readonly<{ result: unknown }>>;
type KustoPolicySnapshot = Readonly<{
	clusterKeys: readonly string[];
	globallyBlocked: boolean;
	version?: number;
	revocationGenerations?: Readonly<Record<string, number>>;
}>;

export type KustoCanonicalSourceAdmission<T> = Readonly<{
	projectedState: T;
	commit(): boolean;
	discard(): void;
	abandonRetry(): void;
}>;

export type KustoResultArtifactAssignment = PersistedResultArtifactV1;

export type KustoAssignedResultTerminal = Readonly<KustoResultTerminal & JsonRecord & {
	result: KustoResultBatchV1;
	resultArtifactAssignment: KustoResultArtifactAssignment;
	resultSetCount: number;
	selectedResultIndex: number;
}>;

export type KustoResultSelectionRequest = Readonly<{
	requestId: string;
	boxId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	primaryArtifactId: string;
	resultIndex: number;
}>;

export type KustoResultSelectionResponse = Readonly<{
	accepted: boolean;
	resultIndex?: number;
}>;

type ResultAttachment = Readonly<{
	resultJson: string;
	resultArtifact: KustoResultArtifactAssignment;
	kustoAccountPartition: string;
	kustoLeaveNoTraceRevision: number;
	selectedResultIndex: number;
	resultSetCount: number;
	executionId: string;
	clusterUrl: string;
	authorityId: string;
	connectionId: string;
	database: string;
	connectionRevision?: number;
	connectionIdentityKey: string;
	sectionInstanceId: string;
	targetGeneration: number;
}>;

export type KustoCommittedResultSummary = Readonly<{
	boxId: string;
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	primaryArtifactId: string;
	resultSetCount: number;
	selectedResultIndex: number;
}>;

type CanonicalSectionState =
	| Readonly<{ kind: 'managed'; attachment?: ResultAttachment }>
	| Readonly<{
		kind: 'inert';
		fields: Readonly<JsonRecord>;
		target?: Readonly<JsonRecord>;
		authoredTarget?: Readonly<JsonRecord>;
		targetOwnerBoxId?: string;
	}>;

type StagedPublication = Readonly<{
	publicationId: string;
	panelId: string;
	boxId: string;
	terminal: KustoAssignedResultTerminal;
	attachment?: ResultAttachment;
}>;

type ActiveExecution = Readonly<KustoExecutionRequestIdentity & { reservationSequence: number }>;
type PreparedSourceObservation = {
	ownerMutationRevision: number;
	activeAdmissions: number;
	nextRetryToken: number;
	retryClaims: Map<number, string>;
	provisionalInertFieldsByBoxId: Map<string, Readonly<JsonRecord>>;
};

type PreparedTargetAdmission = Readonly<{
	allowed: boolean;
	target:
		| Readonly<{ kind: 'committed'; attachment: ResultAttachment }>
		| Readonly<{ kind: 'descriptorless'; record: Readonly<JsonRecord> }>;
}>;
const MAX_OWNER_HISTORY = 256;

const attachmentKeys = [
	'resultJson',
	'resultArtifact',
	'kustoAccountPartition',
	'kustoLeaveNoTraceRevision',
	'selectedResultIndex',
] as const;

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDescriptorlessMigratedResult(record: JsonRecord): boolean {
	return typeof record.resultJson === 'string' && !!record.resultJson
		&& !isRecord(record.resultArtifact)
		&& typeof record.kustoAccountPartition === 'string'
		&& !!record.kustoAccountPartition.trim()
		&& Number.isSafeInteger(record.kustoLeaveNoTraceRevision)
		&& Number(record.kustoLeaveNoTraceRevision) >= 0;
}

function cloneResultState<T extends ResultState>(state: T): T | undefined {
	try {
		const serialized = JSON.stringify(state);
		return serialized ? JSON.parse(serialized) as T : undefined;
	} catch {
		return undefined;
	}
}

function normalize(value: unknown): string {
	return String(value || '').trim();
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_OWNER_HISTORY) map.delete(map.keys().next().value!);
}

function addBounded(set: Set<string>, value: string): void {
	set.delete(value);
	set.add(value);
	while (set.size > MAX_OWNER_HISTORY) set.delete(set.values().next().value!);
}

function parseResultJson(value: string): ReturnType<typeof parseKustoResultBatch> | undefined {
	try {
		return parseKustoResultBatch(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function selectionRequestEquals(
	left: KustoResultSelectionRequest,
	right: KustoResultSelectionRequest,
): boolean {
	return left.requestId === right.requestId
		&& left.boxId === right.boxId
		&& left.sectionInstanceId === right.sectionInstanceId
		&& left.targetGeneration === right.targetGeneration
		&& left.primaryArtifactId === right.primaryArtifactId
		&& left.resultIndex === right.resultIndex;
}

function resultAssignmentAsArtifact(assignment: KustoResultArtifactAssignment): ResultArtifact {
	return Object.freeze({
		artifactId: assignment.artifactId,
		sourceBoxId: assignment.sourceBoxId,
		resultIndex: 0,
		revision: assignment.revision,
		createdAt: assignment.createdAt,
		restored: false,
		columns: Object.freeze([]),
		rows: Object.freeze([]),
		metadata: Object.freeze({}),
		...(assignment.producer ? { producer: assignment.producer } : {}),
		...(assignment.policy ? { policy: assignment.policy } : {}),
		lineage: assignment.lineage ?? Object.freeze([]),
	});
}

function directPolicy(dispatch: JsonRecord): ResultArtifactPolicy | undefined {
	const accountPartition = normalize(dispatch.accountPartition);
	const connectionIdentityKey = normalize(dispatch.connectionIdentityKey);
	const authSessionGeneration = Number(dispatch.authSessionGeneration);
	const leaveNoTraceRevision = Number(dispatch.leaveNoTraceRevision);
	const connectionRevision = Number(dispatch.connectionRevision);
	if (!accountPartition || !connectionIdentityKey
		|| !Number.isSafeInteger(authSessionGeneration) || authSessionGeneration < 0
		|| !Number.isSafeInteger(leaveNoTraceRevision) || leaveNoTraceRevision < 0
		|| !Number.isSafeInteger(connectionRevision) || connectionRevision < 0) return undefined;
	return Object.freeze({
		accountPartition,
		authSessionGeneration,
		leaveNoTraceRevision,
		connectionRevision,
		connectionIdentityKey,
		exposeToActiveContent: true,
		sendToModel: true,
		shareToClipboard: true,
		exportToCsv: true,
	});
}

function producerFromTerminal(terminal: JsonRecord): ResultArtifactProducer {
	return Object.freeze({
		engine: 'kusto',
		boxId: normalize(terminal.boxId),
		executionId: normalize(terminal.executionId),
		sectionInstanceId: normalize(terminal.sectionInstanceId),
		targetGeneration: Number(terminal.targetGeneration),
		reservationSequence: Number(terminal.reservationSequence),
		connectionId: normalize(terminal.connectionId),
		database: normalize(terminal.database),
		...(typeof terminal.query === 'string' ? { query: terminal.query } : {}),
		producer: normalize(terminal.producer),
		dispatch: Object.freeze({ ...(terminal.dispatch as JsonRecord) }),
	});
}

function attachmentFields(record: JsonRecord): JsonRecord {
	const fields: JsonRecord = {};
	const markerless = !Object.prototype.hasOwnProperty.call(record, 'kustoAccountPartition')
		&& !Object.prototype.hasOwnProperty.call(record, 'kustoLeaveNoTraceRevision');
	for (const key of attachmentKeys) {
		if (markerless && key === 'resultArtifact') continue;
		if (Object.prototype.hasOwnProperty.call(record, key)) fields[key] = record[key];
	}
	return fields;
}

function removeAttachmentFields(record: JsonRecord): JsonRecord {
	const clone = { ...record };
	for (const key of attachmentKeys) delete clone[key];
	return clone;
}

function removeAttachmentTargetFields(record: JsonRecord): JsonRecord {
	const clone = { ...record };
	for (const key of ['clusterUrl', 'authorityId', 'connectionIdHint', 'database']) delete clone[key];
	return clone;
}

function withCommittedAttachment(record: JsonRecord, committed: ResultAttachment): JsonRecord {
	return {
		...removeAttachmentTargetFields(removeAttachmentFields(record)),
		...(committed.clusterUrl ? { clusterUrl: committed.clusterUrl } : {}),
		...(committed.authorityId ? { authorityId: committed.authorityId } : {}),
		...(committed.connectionId ? { connectionIdHint: committed.connectionId } : {}),
		...(committed.database ? { database: committed.database } : {}),
		resultJson: committed.resultJson,
		resultArtifact: committed.resultArtifact,
		kustoAccountPartition: committed.kustoAccountPartition,
		kustoLeaveNoTraceRevision: committed.kustoLeaveNoTraceRevision,
		...(committed.selectedResultIndex > 0
			? { selectedResultIndex: committed.selectedResultIndex }
			: {}),
	};
}

function attachmentMatchesTarget(
	attachment: ResultAttachment,
	target: KustoSectionLifecycleOwner,
): boolean {
	if (normalize(target.connectionId) !== attachment.connectionId
		|| normalize(target.database).toLowerCase() !== attachment.database.toLowerCase()) return false;
	if (Number.isSafeInteger(target.connectionRevision)
		&& target.connectionRevision !== attachment.connectionRevision) return false;
	const connectionIdentityKey = normalize(target.connectionIdentityKey);
	return !connectionIdentityKey || connectionIdentityKey === attachment.connectionIdentityKey;
}

function descriptorlessRecordMatchesTarget(
	record: JsonRecord,
	target: KustoSectionLifecycleOwner,
): boolean {
	const connectionId = normalize(record.connectionIdHint);
	if (connectionId && normalize(target.connectionId) !== connectionId) return false;
	const database = normalize(record.database);
	if (database && normalize(target.database).toLowerCase() !== database.toLowerCase()) return false;
	const clusterKey = kustoClusterKey(record.clusterUrl);
	const targetIdentityKey = normalize(target.connectionIdentityKey);
	if (!clusterKey || !targetIdentityKey) return true;
	const separator = targetIdentityKey.indexOf('|');
	const targetClusterKey = separator >= 0 ? targetIdentityKey.slice(0, separator) : targetIdentityKey;
	if (targetClusterKey !== clusterKey) return false;
	if (!normalize(record.authorityId)) return true;
	try {
		return getKustoConnectionIdentityKey(record.clusterUrl, record.authorityId) === targetIdentityKey;
	} catch {
		return false;
	}
}

function descriptorlessRecordMatchesAuthoredTarget(
	record: JsonRecord,
	target: JsonRecord,
): boolean {
	return legacyKustoTargetMatchesRecord(record, target as any);
}

function recordTargetConflictsAttachment(record: JsonRecord, attachment: ResultAttachment): boolean {
	const connectionId = normalize(record.connectionIdHint);
	if (connectionId && connectionId !== attachment.connectionId) return true;
	const database = normalize(record.database);
	if (database && database.toLowerCase() !== attachment.database.toLowerCase()) return true;
	const clusterUrl = normalize(record.clusterUrl);
	if (clusterUrl && attachment.clusterUrl
		&& kustoClusterKey(clusterUrl) !== kustoClusterKey(attachment.clusterUrl)) return true;
	if (Object.prototype.hasOwnProperty.call(record, 'authorityId')) {
		return normalize(record.authorityId).toLowerCase() !== attachment.authorityId.toLowerCase();
	}
	return false;
}

function recordMatchesAttachment(record: JsonRecord, attachment: ResultAttachment): boolean {
	if (record.resultJson !== attachment.resultJson
		|| record.kustoAccountPartition !== attachment.kustoAccountPartition
		|| Number(record.kustoLeaveNoTraceRevision) !== attachment.kustoLeaveNoTraceRevision) return false;
	const artifact = isRecord(record.resultArtifact) ? record.resultArtifact : undefined;
	return artifact?.version === attachment.resultArtifact.version
		&& artifact.artifactId === attachment.resultArtifact.artifactId
		&& Number(artifact.revision) === attachment.resultArtifact.revision
		&& artifact.sourceBoxId === attachment.resultArtifact.sourceBoxId;
}

function persistedArtifactMatchesRecordTarget(
	record: JsonRecord,
	artifact: KustoResultArtifactAssignment,
): boolean {
	const producer = artifact.producer;
	if (producer?.producer === UNVERIFIED_LEGACY_RESULT_PRODUCER) return false;
	const dispatch = isRecord(producer?.dispatch) ? producer.dispatch : undefined;
	const policy = artifact.policy;
	const connectionId = normalize(producer?.connectionId);
	const database = normalize(producer?.database);
	const clusterUrl = normalize(record.clusterUrl);
	const dispatchClusterUrl = normalize(dispatch?.clusterEndpoint);
	const connectionIdentityKey = normalize(dispatch?.connectionIdentityKey);
	const accountPartition = normalize(dispatch?.accountPartition);
	const connectionRevision = Number(dispatch?.connectionRevision);
	const leaveNoTraceRevision = Number(dispatch?.leaveNoTraceRevision);
	if (!producer || !dispatch || !policy || !connectionId || !database
		|| !dispatchClusterUrl || !connectionIdentityKey || !accountPartition
		|| !Number.isSafeInteger(connectionRevision) || connectionRevision < 0
		|| !Number.isSafeInteger(leaveNoTraceRevision) || leaveNoTraceRevision < 0) return false;
	if (normalize(record.connectionIdHint) !== connectionId
		|| normalize(record.database).toLowerCase() !== database.toLowerCase()
		|| !clusterUrl || kustoClusterKey(clusterUrl) !== kustoClusterKey(dispatchClusterUrl)
		|| normalize(record.authorityId).toLowerCase() !== normalize(dispatch.authorityId).toLowerCase()) return false;
	return normalize(record.kustoAccountPartition) === accountPartition
		&& Number(record.kustoLeaveNoTraceRevision) === leaveNoTraceRevision
		&& normalize(policy.accountPartition) === accountPartition
		&& Number(policy.leaveNoTraceRevision) === leaveNoTraceRevision
		&& Number(policy.connectionRevision) === connectionRevision
		&& normalize(policy.connectionIdentityKey) === connectionIdentityKey;
}

function sectionTypes(state: ResultState): Map<string, string> {
	return new Map((Array.isArray(state.sections) ? state.sections : [])
		.filter(isRecord)
		.map(section => [normalize(section.id), canonicalSectionKind(section.type) ?? normalize(section.type)] as const)
		.filter(([id]) => !!id));
}

function isSqlDerivedQuery(record: JsonRecord, types: ReadonlyMap<string, string>): boolean {
	const sourceBoxId = normalize(record.comparisonSourceBoxId);
	return !!sourceBoxId && types.get(sourceBoxId) === 'sql';
}

export function getRemovedKustoResultSectionIds(before: ResultState, after: ResultState): string[] {
	const beforeSections = Array.isArray(before.sections) ? before.sections : [];
	const afterSections = Array.isArray(after.sections) ? after.sections : [];
	const beforeTypes = sectionTypes(before);
	const afterById = new Map(afterSections
		.filter(isRecord)
		.map(section => [normalize(section.id), section] as const)
		.filter(([id]) => !!id));
	return beforeSections.flatMap(section => {
		if (!isRecord(section) || canonicalSectionKind(section.type) !== 'query'
			|| isSqlDerivedQuery(section, beforeTypes)
			|| typeof section.resultJson !== 'string' || !section.resultJson) return [];
		const boxId = normalize(section.id);
		const current = afterById.get(boxId);
		return boxId && (!current || typeof current.resultJson !== 'string' || !current.resultJson)
			? [boxId]
			: [];
	});
}

export class KustoResultPersistenceOwner {
	private readonly panels = new Map<string, KustoResultPanelSession>();
	private readonly canonicalSections = new Map<string, CanonicalSectionState>();
	private readonly committedByBoxId = new Map<string, ResultAttachment>();
	private readonly attachmentOwnerPanelByBoxId = new Map<string, string>();
	private readonly stagedByPublicationId = new Map<string, StagedPublication>();
	private readonly assignmentByExecution = new Map<string, KustoResultArtifactAssignment>();
	private readonly nextRevisionByBoxId = new Map<string, number>();
	private readonly selectedPreferenceByBoxId = new Map<string, number>();
	private readonly ownedSourceFingerprints = new Map<string, number>();
	private readonly preparedSourceOwnerRevisionByIdentity = new Map<string, PreparedSourceObservation>();
	private readonly latestPreparedSourceIdentityByPanel = new Map<string, string>();
	private ownerMutationRevision = 0;
	private canonicalAuthorityEstablished = false;
	private lastCanonicalSourceRevision = '';
	private lastCanonicalSourceFingerprint = '';
	private lastPolicySnapshotFingerprint: string | undefined;

	constructor(
		readonly documentKey: string,
		private readonly options: Readonly<{ now?: () => number }> = {},
	) {}

	openPanel(panelIdInput: unknown): KustoResultPanelSession {
		const panelId = normalize(panelIdInput);
		if (!panelId) throw new Error('Kusto result panel identity is required.');
		const existing = this.panels.get(panelId);
		if (existing) return existing;
		const session = new KustoResultPanelSession(this, panelId);
		this.panels.set(panelId, session);
		return session;
	}

	closePanel(panelId: string): void {
		this.panels.delete(panelId);
		this.latestPreparedSourceIdentityByPanel.delete(panelId);
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (staged.panelId === panelId) this.stagedByPublicationId.delete(publicationId);
		}
		for (const [sourceIdentity, observation] of this.preparedSourceOwnerRevisionByIdentity) {
			for (const [token, claimPanelId] of observation.retryClaims) {
				if (claimPanelId === panelId) observation.retryClaims.delete(token);
			}
			if (observation.activeAdmissions <= 0 && observation.retryClaims.size === 0) {
				this.preparedSourceOwnerRevisionByIdentity.delete(sourceIdentity);
			}
		}
	}

	private enrichDescriptorlessTarget(
		boxId: string,
		ownerBoxId: string,
		target: Readonly<JsonRecord>,
	): Readonly<{ target: Readonly<JsonRecord>; ambiguous: boolean }> {
		if (normalize(target.connectionIdHint)) return Object.freeze({ target, ambiguous: false });
		const connectionIds = new Set<string>();
		for (const session of this.panels.values()) {
			for (const candidateBoxId of new Set([boxId, ownerBoxId])) {
				const liveTarget = session.getTarget(candidateBoxId);
				if (!liveTarget || liveTarget.targetGeneration === 0
					|| !descriptorlessRecordMatchesTarget(target, liveTarget)) continue;
				const connectionId = normalize(liveTarget.connectionId);
				if (connectionId) connectionIds.add(connectionId);
			}
		}
		return Object.freeze({
			target: connectionIds.size === 1
				? Object.freeze({ ...target, connectionIdHint: [...connectionIds][0] })
				: target,
			ambiguous: connectionIds.size > 1,
		});
	}

	enrichDescriptorlessTargetsForRuntimeOwner(target: KustoSectionLifecycleOwner): void {
		let changed = false;
		for (const [boxId, canonical] of [...this.canonicalSections]) {
			if (canonical.kind !== 'inert' || !canonical.target
				|| (boxId !== target.boxId && canonical.targetOwnerBoxId !== target.boxId)) continue;
			const authoredTarget = canonical.authoredTarget || canonical.target;
			const enrichment = this.enrichDescriptorlessTarget(
				boxId, canonical.targetOwnerBoxId || boxId, authoredTarget,
			);
			if (enrichment.ambiguous) {
				this.revokeBox(boxId);
				continue;
			}
			if (JSON.stringify(enrichment.target) === JSON.stringify(canonical.target)) continue;
			this.canonicalSections.set(boxId, Object.freeze({ ...canonical, target: enrichment.target }));
			changed = true;
		}
		if (changed) this.ownerMutationRevision++;
	}

	admitCanonicalSource(
		fingerprintInput: unknown,
		state: ResultState,
		sourceRevisionInput: unknown = fingerprintInput,
		panelIdInput?: unknown,
	): void {
		const fingerprint = normalize(fingerprintInput);
		const sourceRevision = normalize(sourceRevisionInput);
		const panelId = normalize(panelIdInput);
		if (!fingerprint || !sourceRevision || !Array.isArray(state.sections)) return;
		const types = sectionTypes(state);
		const hadCanonicalAuthority = this.canonicalAuthorityEstablished;
		const incomingKustoIds = new Set<string>();
		let canonicalCoverageComplete = true;
		for (const value of state.sections) {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, types)) continue;
			const boxId = normalize(value.id);
			if (!boxId || !this.canonicalSections.has(boxId)) canonicalCoverageComplete = false;
			if (boxId) incomingKustoIds.add(boxId);
		}
		canonicalCoverageComplete = canonicalCoverageComplete
			&& incomingKustoIds.size === this.canonicalSections.size;
		const claimCommittedAttachmentsForPanel = () => {
			if (!panelId) return;
			for (const boxId of incomingKustoIds) {
				if (this.committedByBoxId.has(boxId)) this.attachmentOwnerPanelByBoxId.set(boxId, panelId);
			}
		};
		this.canonicalAuthorityEstablished = true;
		const exactSourcePair = sourceRevision === this.lastCanonicalSourceRevision
			&& fingerprint === this.lastCanonicalSourceFingerprint;
		let admittedState = state;
		if (exactSourcePair && hadCanonicalAuthority && canonicalCoverageComplete) {
			claimCommittedAttachmentsForPanel();
			return;
		}
		if (exactSourcePair && hadCanonicalAuthority) {
			admittedState = this.rebaseCandidateOnCurrentOwner(state);
		} else {
			this.lastCanonicalSourceRevision = sourceRevision;
			this.lastCanonicalSourceFingerprint = fingerprint;
		}
		const ownedMutationRevision = this.ownedSourceFingerprints.get(fingerprint);
		if (ownedMutationRevision !== undefined) {
			this.ownedSourceFingerprints.delete(fingerprint);
			if (ownedMutationRevision === this.ownerMutationRevision && hadCanonicalAuthority) {
				if (canonicalCoverageComplete) {
					claimCommittedAttachmentsForPanel();
					return;
				}
				admittedState = this.rebaseCandidateOnCurrentOwner(state);
			}
		}
		this.ownerMutationRevision++;
		const admittedTypes = admittedState === state ? types : sectionTypes(admittedState);
		const admittedSectionsById = new Map((Array.isArray(admittedState.sections) ? admittedState.sections : [])
			.filter(isRecord)
			.map(section => [normalize(section.id), section] as const)
			.filter(([id]) => !!id));
		const nextIds = new Set<string>();
		for (const value of Array.isArray(admittedState.sections) ? admittedState.sections : []) {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, admittedTypes)) continue;
			const boxId = normalize(value.id);
			if (!boxId) continue;
			nextIds.add(boxId);
			const currentCommitted = this.committedByBoxId.get(boxId);
			const hasResult = typeof value.resultJson === 'string' && value.resultJson.length > 0;
			const hasAccount = typeof value.kustoAccountPartition === 'string'
				&& value.kustoAccountPartition.trim().length > 0;
			const hasRevision = Number.isSafeInteger(value.kustoLeaveNoTraceRevision)
				&& Number(value.kustoLeaveNoTraceRevision) >= 0;
			const markerless = !Object.prototype.hasOwnProperty.call(value, 'kustoAccountPartition')
				&& !Object.prototype.hasOwnProperty.call(value, 'kustoLeaveNoTraceRevision');
			const incomingArtifact = isRecord(value.resultArtifact)
				? value.resultArtifact as unknown as KustoResultArtifactAssignment
				: undefined;
			const incomingRevision = Number(incomingArtifact?.revision);
			const parsedIncomingResult = hasResult ? parseResultJson(String(value.resultJson)) : undefined;
			const validIncomingArtifact = !!incomingArtifact
				&& parsedIncomingResult?.ok === true
				&& hasAccount && hasRevision
				&& incomingArtifact.version === 1
				&& incomingArtifact.sourceBoxId === boxId
				&& typeof incomingArtifact.artifactId === 'string'
				&& Number.isSafeInteger(incomingRevision);
			const coherentIncomingArtifact = validIncomingArtifact
				&& persistedArtifactMatchesRecordTarget(value, incomingArtifact!);
			if (currentCommitted
				&& recordTargetConflictsAttachment(value, currentCommitted)
				&& (!coherentIncomingArtifact
					|| incomingRevision <= currentCommitted.resultArtifact.revision)) {
				this.committedByBoxId.delete(boxId);
				this.selectedPreferenceByBoxId.delete(boxId);
				this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
				continue;
			}
			if (currentCommitted
				&& incomingRevision > currentCommitted.resultArtifact.revision
				&& !coherentIncomingArtifact) {
				this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment: currentCommitted }));
				continue;
			}
			if (!hasResult) {
				this.committedByBoxId.delete(boxId);
				this.selectedPreferenceByBoxId.delete(boxId);
				this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
				continue;
			}
			if (hasResult && (markerless || !isRecord(value.resultArtifact))) {
				if (currentCommitted) {
					this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment: currentCommitted }));
					continue;
				}
				const effectiveTarget = isDescriptorlessMigratedResult(value)
					? resolveLegacyKustoEffectiveTarget(value, admittedSectionsById)
					: undefined;
				const targetResolution = effectiveTarget?.kind === 'kusto' ? effectiveTarget : undefined;
				if (isDescriptorlessMigratedResult(value) && !targetResolution) {
					this.committedByBoxId.delete(boxId);
					this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
					continue;
				}
				const enrichment = targetResolution
					? this.enrichDescriptorlessTarget(
						boxId, targetResolution.ownerBoxId, targetResolution.target,
					)
					: undefined;
				if (enrichment?.ambiguous) {
					this.committedByBoxId.delete(boxId);
					this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
					continue;
				}
				const target = enrichment?.target;
				this.canonicalSections.set(boxId, Object.freeze({
					kind: 'inert', fields: Object.freeze(attachmentFields(value)),
					...(target && targetResolution ? {
						target,
						authoredTarget: targetResolution.target,
						targetOwnerBoxId: targetResolution.ownerBoxId,
					} : {}),
				}));
				this.committedByBoxId.delete(boxId);
				continue;
			}
			if (coherentIncomingArtifact && incomingArtifact) {
				const resultArtifact = value.resultArtifact as unknown as KustoResultArtifactAssignment;
				const parsed = parsedIncomingResult;
				if (parsed?.ok && resultArtifact.version === 1
					&& resultArtifact.sourceBoxId === boxId
					&& typeof resultArtifact.artifactId === 'string'
					&& Number.isSafeInteger(resultArtifact.revision)) {
					if (currentCommitted
						&& Number(resultArtifact.revision) <= currentCommitted.resultArtifact.revision) {
						this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment: currentCommitted }));
						continue;
					}
					const selectedResultIndex = Number.isSafeInteger(value.selectedResultIndex)
						&& Number(value.selectedResultIndex) >= 0
						&& Number(value.selectedResultIndex) < getKustoResultSets(parsed.value).length
						? Number(value.selectedResultIndex)
						: 0;
					const attachment: ResultAttachment = Object.freeze({
						resultJson: String(value.resultJson),
						resultArtifact,
						kustoAccountPartition: String(value.kustoAccountPartition),
						kustoLeaveNoTraceRevision: Number(value.kustoLeaveNoTraceRevision),
						selectedResultIndex,
						resultSetCount: getKustoResultSets(parsed.value).length,
						executionId: normalize(resultArtifact.producer?.executionId),
						clusterUrl: normalize(value.clusterUrl),
						authorityId: normalize(value.authorityId),
						connectionId: normalize(resultArtifact.producer?.connectionId),
						database: normalize(resultArtifact.producer?.database),
						...(Number.isSafeInteger(resultArtifact.policy?.connectionRevision)
							? { connectionRevision: Number(resultArtifact.policy?.connectionRevision) }
							: {}),
						connectionIdentityKey: normalize(resultArtifact.policy?.connectionIdentityKey),
						sectionInstanceId: normalize(resultArtifact.producer?.sectionInstanceId),
						targetGeneration: Number(resultArtifact.producer?.targetGeneration ?? 0),
					});
					this.committedByBoxId.set(boxId, attachment);
					this.selectedPreferenceByBoxId.set(boxId, selectedResultIndex);
					this.nextRevisionByBoxId.set(boxId, Math.max(
						this.nextRevisionByBoxId.get(boxId) ?? 0,
						Number(resultArtifact.revision),
					));
					if (attachment.executionId) {
						setBounded(
							this.assignmentByExecution,
							`${boxId}\u0000${attachment.executionId}`,
							resultArtifact,
						);
					}
					this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment }));
					continue;
				}
			}
			if (currentCommitted) {
				this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment: currentCommitted }));
				continue;
			}
			this.committedByBoxId.delete(boxId);
			this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
		}
		for (const boxId of [...this.canonicalSections.keys()]) {
			if (nextIds.has(boxId)) continue;
			this.canonicalSections.delete(boxId);
			this.committedByBoxId.delete(boxId);
			this.attachmentOwnerPanelByBoxId.delete(boxId);
			this.selectedPreferenceByBoxId.delete(boxId);
		}
		for (const boxId of nextIds) {
			if (!this.committedByBoxId.has(boxId)) this.attachmentOwnerPanelByBoxId.delete(boxId);
		}
		if (panelId) {
			for (const boxId of nextIds) {
				if (this.committedByBoxId.has(boxId)) this.attachmentOwnerPanelByBoxId.set(boxId, panelId);
			}
		}
	}

	prepareCanonicalSource<T extends ResultState>(
		fingerprintInput: unknown,
		state: T,
		sourceRevisionInput: unknown = fingerprintInput,
		panelIdInput?: unknown,
	): KustoCanonicalSourceAdmission<T> | undefined {
		const fingerprint = normalize(fingerprintInput);
		const sourceRevision = normalize(sourceRevisionInput);
		const panelId = normalize(panelIdInput);
		if (!fingerprint || !sourceRevision || !Array.isArray(state.sections)) return undefined;
		if (panelId && !this.panels.has(panelId)) return undefined;
		const sourceIdentity = `${sourceRevision}\u0000${fingerprint}`;
		this.retireOtherPanelRetryClaims(panelId, sourceIdentity);
		let observation = this.preparedSourceOwnerRevisionByIdentity.get(sourceIdentity);
		if (!observation) {
			observation = {
				ownerMutationRevision: this.ownerMutationRevision,
				activeAdmissions: 0,
				nextRetryToken: 0,
				retryClaims: new Map(),
				provisionalInertFieldsByBoxId: new Map(),
			};
			this.preparedSourceOwnerRevisionByIdentity.set(sourceIdentity, observation);
		}
		observation.activeAdmissions++;
		const releaseObservation = () => {
			observation.activeAdmissions--;
			if (observation.activeAdmissions <= 0 && observation.retryClaims.size === 0
				&& this.preparedSourceOwnerRevisionByIdentity.get(sourceIdentity) === observation) {
				this.preparedSourceOwnerRevisionByIdentity.delete(sourceIdentity);
			}
		};
		let candidateState = cloneResultState(state);
		if (candidateState && observation.ownerMutationRevision !== this.ownerMutationRevision) {
			candidateState = this.rebaseCandidateOnCurrentOwner(candidateState);
		}
		const previewState = candidateState ? cloneResultState(candidateState) : undefined;
		if (!candidateState || !previewState
			|| !Array.isArray(candidateState.sections) || !Array.isArray(previewState.sections)) {
			releaseObservation();
			return undefined;
		}
		const expectedOwnerMutationRevision = this.ownerMutationRevision;
		const preparedOwnedSource = this.ownedSourceFingerprints.get(fingerprint)
			=== expectedOwnerMutationRevision;
		const preview = this.cloneForCanonicalPreview();
		preview.admitCanonicalSource(fingerprint, previewState, sourceRevision);
		const preparedTargetAdmissions = new Map<string, PreparedTargetAdmission>();
		for (const [boxId, attachment] of preview.committedByBoxId) {
			const allowed = this.currentTargetsAllowAttachment(panelId, boxId, attachment);
			preparedTargetAdmissions.set(boxId, Object.freeze({
				allowed,
				target: Object.freeze({ kind: 'committed' as const, attachment }),
			}));
			if (!allowed) preview.revokeBox(boxId);
		}
		const previewTypes = sectionTypes(previewState);
		for (const value of previewState.sections) {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, previewTypes)) continue;
			const boxId = normalize(value.id);
			const canonical = boxId ? preview.canonicalSections.get(boxId) : undefined;
			if (!boxId || preparedTargetAdmissions.has(boxId)
				|| canonical?.kind !== 'inert' || !canonical.target) continue;
			const record = canonical.target;
			const allowed = this.currentTargetsAllowDescriptorlessRecord(panelId, boxId, record);
			preparedTargetAdmissions.set(boxId, Object.freeze({
				allowed,
				target: Object.freeze({ kind: 'descriptorless' as const, record }),
			}));
			if (!allowed) preview.revokeBox(boxId);
		}
		const projectedState = preview.overlaySnapshot(previewState);
		observation.provisionalInertFieldsByBoxId.clear();
		for (const value of Array.isArray(projectedState.sections) ? projectedState.sections : []) {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| typeof value.resultJson !== 'string' || !value.resultJson
				|| Object.prototype.hasOwnProperty.call(value, 'kustoAccountPartition')
				|| Object.prototype.hasOwnProperty.call(value, 'kustoLeaveNoTraceRevision')) continue;
			const boxId = normalize(value.id);
			if (boxId) {
				observation.provisionalInertFieldsByBoxId.set(
					boxId, Object.freeze(attachmentFields(value)),
				);
			}
		}
		if (panelId) this.latestPreparedSourceIdentityByPanel.set(panelId, sourceIdentity);
		const openingAttachments = new Map(preview.committedByBoxId);
		candidateState = cloneResultState(projectedState);
		if (!candidateState) {
			releaseObservation();
			return undefined;
		}
		let committed = false;
		let conflictRetryToken: number | undefined;
		return Object.freeze({
			projectedState,
			commit: () => {
				if (committed) return false;
				committed = true;
				observation.activeAdmissions--;
				if (this.ownerMutationRevision !== expectedOwnerMutationRevision
					|| !this.preparedTargetAdmissionsRemainCurrent(
						panelId, preparedTargetAdmissions,
					)) {
					conflictRetryToken = ++observation.nextRetryToken;
					observation.retryClaims.set(conflictRetryToken, panelId);
					return false;
				}
				for (const [boxId, attachment] of [...this.committedByBoxId]) {
					if (openingAttachments.get(boxId) !== attachment) this.revokeBox(boxId);
				}
				if (preparedOwnedSource) {
					setBounded(this.ownedSourceFingerprints, fingerprint, this.ownerMutationRevision);
				}
				this.admitCanonicalSource(fingerprint, candidateState, sourceRevision, panelId);
				for (const [ownedFingerprint, ownerRevision] of this.ownedSourceFingerprints) {
					if (ownerRevision === expectedOwnerMutationRevision) {
						this.ownedSourceFingerprints.set(ownedFingerprint, this.ownerMutationRevision);
					}
				}
				this.retireOtherPanelRetryClaims(panelId, sourceIdentity);
				for (const [token, claimPanelId] of observation.retryClaims) {
					if (claimPanelId === panelId) observation.retryClaims.delete(token);
				}
				if (observation.activeAdmissions <= 0 && observation.retryClaims.size === 0
					&& this.preparedSourceOwnerRevisionByIdentity.get(sourceIdentity) === observation) {
					this.preparedSourceOwnerRevisionByIdentity.delete(sourceIdentity);
				}
				return true;
			},
			discard: () => {
				if (!committed) {
					releaseObservation();
				}
				committed = true;
			},
			abandonRetry: () => {
				if (conflictRetryToken === undefined
					|| this.preparedSourceOwnerRevisionByIdentity.get(sourceIdentity) !== observation) return;
				observation.retryClaims.delete(conflictRetryToken);
				if (observation.activeAdmissions <= 0 && observation.retryClaims.size === 0) {
					this.preparedSourceOwnerRevisionByIdentity.delete(sourceIdentity);
				}
			},
		});
	}

	private retireOtherPanelRetryClaims(panelId: string, retainedSourceIdentity: string): void {
		if (!panelId) return;
		for (const [sourceIdentity, observation] of this.preparedSourceOwnerRevisionByIdentity) {
			if (sourceIdentity === retainedSourceIdentity) continue;
			for (const [token, claimPanelId] of observation.retryClaims) {
				if (claimPanelId === panelId) observation.retryClaims.delete(token);
			}
			if (observation.activeAdmissions <= 0 && observation.retryClaims.size === 0) {
				this.preparedSourceOwnerRevisionByIdentity.delete(sourceIdentity);
			}
		}
	}

	private currentTargetsAllowAttachment(
		panelId: string,
		boxId: string,
		attachment: ResultAttachment,
	): boolean {
		const sessions = panelId ? [this.panels.get(panelId)] : [...this.panels.values()];
		if (panelId && !sessions[0]) return false;
		for (const session of sessions) {
			if (!session) continue;
			const target = session.getTarget(boxId);
			if (!target) continue;
			const unresolved = target.targetGeneration === 0
				&& !normalize(target.connectionId)
				&& !normalize(target.database);
			if (!unresolved && !attachmentMatchesTarget(attachment, target)) return false;
		}
		return true;
	}

	private currentTargetsAllowDescriptorlessRecord(
		panelId: string,
		boxId: string,
		record: JsonRecord,
	): boolean {
		const sessions = panelId ? [this.panels.get(panelId)] : [...this.panels.values()];
		if (panelId && !sessions[0]) return false;
		for (const session of sessions) {
			if (!session) continue;
			const target = session.getTarget(boxId);
			if (!target) continue;
			const unresolved = target.targetGeneration === 0
				&& !normalize(target.connectionId)
				&& !normalize(target.database);
			if (!unresolved && !descriptorlessRecordMatchesTarget(record, target)) return false;
		}
		return true;
	}

	private preparedTargetAdmissionsRemainCurrent(
		panelId: string,
		admissions: ReadonlyMap<string, PreparedTargetAdmission>,
	): boolean {
		for (const [boxId, admission] of admissions) {
			const allowed = admission.target.kind === 'committed'
				? this.currentTargetsAllowAttachment(panelId, boxId, admission.target.attachment)
				: this.currentTargetsAllowDescriptorlessRecord(panelId, boxId, admission.target.record);
			if (allowed !== admission.allowed) return false;
		}
		return true;
	}

	private cloneForCanonicalPreview(): KustoResultPersistenceOwner {
		const preview = new KustoResultPersistenceOwner(this.documentKey, this.options);
		for (const [panelId, session] of this.panels) {
			const previewSession = preview.openPanel(panelId);
			for (const target of session.getTargetsSnapshot()) {
				previewSession.openSection(target.boxId, target.sectionInstanceId);
				if (target.targetGeneration > 0
					|| normalize(target.connectionId) || normalize(target.database)) {
					previewSession.adoptTarget(target);
				}
			}
		}
		preview.canonicalAuthorityEstablished = this.canonicalAuthorityEstablished;
		preview.ownerMutationRevision = this.ownerMutationRevision;
		preview.lastCanonicalSourceRevision = this.lastCanonicalSourceRevision;
		preview.lastCanonicalSourceFingerprint = this.lastCanonicalSourceFingerprint;
		for (const [key, value] of this.canonicalSections) preview.canonicalSections.set(key, value);
		for (const [key, value] of this.committedByBoxId) preview.committedByBoxId.set(key, value);
		for (const [key, value] of this.attachmentOwnerPanelByBoxId) {
			preview.attachmentOwnerPanelByBoxId.set(key, value);
		}
		for (const [key, value] of this.assignmentByExecution) preview.assignmentByExecution.set(key, value);
		for (const [key, value] of this.nextRevisionByBoxId) preview.nextRevisionByBoxId.set(key, value);
		for (const [key, value] of this.selectedPreferenceByBoxId) preview.selectedPreferenceByBoxId.set(key, value);
		for (const [key, value] of this.ownedSourceFingerprints) preview.ownedSourceFingerprints.set(key, value);
		return preview;
	}

	private rebaseCandidateOnCurrentOwner<T extends ResultState>(state: T): T {
		if (!Array.isArray(state.sections) || !this.canonicalAuthorityEstablished) return state;
		const types = sectionTypes(state);
		const sections = state.sections.map(value => {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, types)) return value;
			const boxId = normalize(value.id);
			if (!boxId) return value;
			const committed = this.committedByBoxId.get(boxId);
			if (committed && !recordTargetConflictsAttachment(value, committed)) {
				return withCommittedAttachment(value, committed);
			}
			const canonical = this.canonicalSections.get(boxId);
			if (canonical?.kind === 'managed' && !canonical.attachment) {
				const markerless = typeof value.resultJson === 'string' && !!value.resultJson
					&& !Object.prototype.hasOwnProperty.call(value, 'kustoAccountPartition')
					&& !Object.prototype.hasOwnProperty.call(value, 'kustoLeaveNoTraceRevision');
				return markerless
					? { ...removeAttachmentFields(value), ...attachmentFields(value) }
					: removeAttachmentFields(value);
			}
			if (canonical?.kind === 'inert') {
				return !canonical.target || descriptorlessRecordMatchesAuthoredTarget(value, canonical.target)
					? { ...removeAttachmentFields(value), ...canonical.fields }
					: removeAttachmentFields(value);
			}
			return value;
		});
		return { ...state, sections };
	}

	markOwnedSourceFingerprint(fingerprintInput: unknown): void {
		const fingerprint = normalize(fingerprintInput);
		if (fingerprint) setBounded(this.ownedSourceFingerprints, fingerprint, this.ownerMutationRevision);
	}

	discardOwnedSourceFingerprint(fingerprintInput: unknown): void {
		this.ownedSourceFingerprints.delete(normalize(fingerprintInput));
	}

	overlaySnapshot<T extends ResultState>(state: T, panelIdInput?: unknown): T {
		if (!Array.isArray(state.sections)) return state;
		const panelId = normalize(panelIdInput);
		const sourceIdentity = panelId ? this.latestPreparedSourceIdentityByPanel.get(panelId) : undefined;
		const observation = sourceIdentity
			? this.preparedSourceOwnerRevisionByIdentity.get(sourceIdentity)
			: undefined;
		if (!this.canonicalAuthorityEstablished && !observation) return state;
		const types = sectionTypes(state);
		let changed = false;
		const sections = state.sections.map(value => {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, types)) return value;
			const boxId = normalize(value.id);
			if (!boxId) return value;
			const base = removeAttachmentFields(value);
			const canonical = this.canonicalSections.get(boxId);
			const committed = this.committedByBoxId.get(boxId);
			let next = base;
			if (committed && (!panelId
				|| this.currentTargetsAllowAttachment(panelId, boxId, committed))) {
				next = withCommittedAttachment(value, committed);
			} else if (canonical?.kind === 'inert') {
				const targetAllowed = !canonical.target || (
					descriptorlessRecordMatchesAuthoredTarget(value, canonical.target)
					&& this.currentTargetsAllowDescriptorlessRecord(panelId, boxId, canonical.target)
				);
				if (targetAllowed) next = { ...base, ...canonical.fields };
			} else if (observation && (observation.activeAdmissions > 0
				|| [...observation.retryClaims.values()].includes(panelId))) {
				const provisional = observation.provisionalInertFieldsByBoxId.get(boxId);
				if (provisional) next = { ...base, ...provisional };
			} else if (canonical?.kind === 'managed' && !canonical.attachment
				&& typeof value.resultJson === 'string' && !!value.resultJson
				&& !Object.prototype.hasOwnProperty.call(value, 'kustoAccountPartition')
				&& !Object.prototype.hasOwnProperty.call(value, 'kustoLeaveNoTraceRevision')) {
				next = { ...base, ...attachmentFields(value) };
			}
			changed = changed || JSON.stringify(next) !== JSON.stringify(value);
			return next;
		});
		return changed ? { ...state, sections } : state;
	}

	revokeSanitizedAttachments(before: ResultState, after: ResultState): void {
		const removedIds = getRemovedKustoResultSectionIds(before, after);
		if (removedIds.length === 0 || !Array.isArray(before.sections)) return;
		const revisionBeforeRemoval = this.ownerMutationRevision;
		const beforeById = new Map(before.sections
			.filter(isRecord)
			.map(section => [normalize(section.id), section] as const)
			.filter(([id]) => !!id));
		for (const boxId of removedIds) {
			const attachment = this.committedByBoxId.get(boxId);
			const canonical = this.canonicalSections.get(boxId);
			const record = beforeById.get(boxId);
			const exactCommitted = !!attachment && !!record && recordMatchesAttachment(record, attachment);
			const exactInert = canonical?.kind === 'inert' && !!record
				&& JSON.stringify(attachmentFields(record)) === JSON.stringify(canonical.fields);
			if (exactCommitted || exactInert) this.revokeBox(boxId);
		}
		if (this.ownerMutationRevision === revisionBeforeRemoval) this.ownerMutationRevision++;
	}

	revokePolicyIncompatibleAttachments(snapshot: KustoPolicySnapshot): void {
		const protectedClusters = new Set(snapshot.clusterKeys.map(kustoClusterKey).filter(Boolean));
		const policyFingerprint = JSON.stringify({
			version: Number(snapshot.version ?? 0),
			globallyBlocked: snapshot.globallyBlocked,
			clusterKeys: [...protectedClusters].sort(),
			revocationGenerations: Object.entries(snapshot.revocationGenerations ?? {})
				.map(([cluster, revision]) => [kustoClusterKey(cluster), Number(revision)] as const)
				.filter(([cluster]) => !!cluster)
				.sort(([left], [right]) => left.localeCompare(right)),
		});
		if (this.lastPolicySnapshotFingerprint === undefined) {
			this.lastPolicySnapshotFingerprint = policyFingerprint;
		} else if (this.lastPolicySnapshotFingerprint !== policyFingerprint) {
			this.lastPolicySnapshotFingerprint = policyFingerprint;
			this.ownerMutationRevision++;
		}
		const incompatible = (attachment: ResultAttachment): boolean => {
			const clusterKey = kustoClusterKey(attachment.clusterUrl);
			const currentRevision = Number(snapshot.revocationGenerations?.[clusterKey] ?? 0);
			return snapshot.globallyBlocked
				|| (!!clusterKey && protectedClusters.has(clusterKey))
				|| !Number.isSafeInteger(currentRevision)
				|| currentRevision !== attachment.kustoLeaveNoTraceRevision;
		};
		for (const [boxId, attachment] of [...this.committedByBoxId]) {
			if (incompatible(attachment)) this.revokeBox(boxId);
		}
		for (const [boxId, canonical] of [...this.canonicalSections]) {
			if (canonical.kind !== 'inert' || !canonical.target) continue;
			const clusterKey = kustoClusterKey(canonical.target.clusterUrl);
			const expectedRevision = Number(canonical.fields.kustoLeaveNoTraceRevision);
			const currentRevision = Number(snapshot.revocationGenerations?.[clusterKey] ?? 0);
			if (snapshot.globallyBlocked
				|| !clusterKey
				|| protectedClusters.has(clusterKey)
				|| !Number.isSafeInteger(expectedRevision)
				|| expectedRevision < 0
				|| !Number.isSafeInteger(currentRevision)
				|| currentRevision !== expectedRevision) {
				this.revokeBox(boxId);
			}
		}
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (staged.attachment && incompatible(staged.attachment)) {
				this.stagedByPublicationId.delete(publicationId);
			}
		}
	}

	stage(panelId: string, publicationId: string, terminalInput: unknown): KustoAssignedResultTerminal | undefined {
		if (!this.panels.has(panelId) || !publicationId || !isRecord(terminalInput)
			|| terminalInput.type !== 'queryResult' || !hasKustoExecutionTerminalStamp(terminalInput, true)) return undefined;
		const terminalRecord = terminalInput as KustoExecutionTerminalStamp & JsonRecord;
		const session = this.panels.get(panelId)!;
		const active = session.getActiveExecution(normalize(terminalRecord.boxId));
		if (!active || !kustoExecutionIdentityEquals(active, terminalRecord)) return undefined;
		const parsed = parseKustoResultBatch(terminalRecord.result);
		if (!parsed.ok) return undefined;
		const boxId = normalize(terminalRecord.boxId);
		const revision = (this.nextRevisionByBoxId.get(boxId) ?? 0) + 1;
		const identity = createPrimaryResultArtifactIdentity(boxId, revision, this.options.now?.() ?? Date.now());
		if (!identity) return undefined;
		this.nextRevisionByBoxId.set(boxId, revision);
		const producer = producerFromTerminal(terminalRecord);
		let policy = directPolicy(terminalRecord.dispatch as JsonRecord);
		let lineage: readonly { sourceArtifactId: string; role?: string }[] | undefined;
		const comparisonRun = isRecord(terminalRecord.comparisonRun) ? terminalRecord.comparisonRun : undefined;
		if (comparisonRun && normalize(terminalRecord.boxId) === normalize(comparisonRun.comparisonBoxId)) {
			const sourceAssignment = this.assignmentByExecution.get(
				`${normalize(comparisonRun.sourceBoxId)}\u0000${normalize(comparisonRun.sourceExecutionId)}`,
			);
			if (!sourceAssignment) return undefined;
			const derived = createDerivedResultArtifactPublication(
				producer,
				[{ artifact: resultAssignmentAsArtifact(sourceAssignment), role: 'comparison-source' }],
			);
			policy = derived.policy;
			lineage = derived.lineage;
		}
		if (!policy) return undefined;
		const assignment: KustoResultArtifactAssignment = Object.freeze({
			version: 1,
			...identity,
			producer,
			policy,
			...(lineage?.length ? { lineage } : {}),
		});
		const serialized = serializeKustoResultBatchForPersistence(parsed.value);
		const selectedPreference = this.selectedPreferenceByBoxId.get(boxId) ?? 0;
		const selectedResultIndex = selectedPreference >= 0
			&& selectedPreference < getKustoResultSets(parsed.value).length
			? selectedPreference
			: 0;
		const attachment = serialized.json ? Object.freeze({
			resultJson: serialized.json,
			resultArtifact: assignment,
			kustoAccountPartition: String(policy.accountPartition),
			kustoLeaveNoTraceRevision: Number(policy.leaveNoTraceRevision),
			selectedResultIndex,
			resultSetCount: getKustoResultSets(parsed.value).length,
			executionId: normalize(terminalRecord.executionId),
			clusterUrl: normalize((terminalRecord.dispatch as JsonRecord).clusterEndpoint),
			authorityId: normalize((terminalRecord.dispatch as JsonRecord).authorityId),
			connectionId: normalize(terminalRecord.connectionId),
			database: normalize(terminalRecord.database),
			connectionRevision: Number(policy.connectionRevision),
			connectionIdentityKey: normalize(policy.connectionIdentityKey),
			sectionInstanceId: normalize(terminalRecord.sectionInstanceId),
			targetGeneration: Number(terminalRecord.targetGeneration),
		}) : undefined;
		const terminal = Object.freeze({
			...terminalRecord,
			result: parsed.value,
			resultArtifactAssignment: assignment,
			resultSetCount: getKustoResultSets(parsed.value).length,
			selectedResultIndex,
		}) as unknown as KustoAssignedResultTerminal;
		this.stagedByPublicationId.set(publicationId, Object.freeze({
			publicationId, panelId, boxId, terminal, ...(attachment ? { attachment } : {}),
		}));
		return terminal;
	}

	commit(panelId: string, publicationId: string): boolean {
		const staged = this.stagedByPublicationId.get(publicationId);
		if (!staged || staged.panelId !== panelId) return false;
		const session = this.panels.get(panelId);
		const active = session?.getActiveExecution(staged.boxId);
		if (!active || !kustoExecutionIdentityEquals(active, staged.terminal)) {
			this.stagedByPublicationId.delete(publicationId);
			return false;
		}
		this.stagedByPublicationId.delete(publicationId);
		if (staged.attachment) {
			this.ownerMutationRevision++;
			this.committedByBoxId.set(staged.boxId, staged.attachment);
			this.attachmentOwnerPanelByBoxId.set(staged.boxId, panelId);
			this.canonicalSections.set(staged.boxId, Object.freeze({ kind: 'managed', attachment: staged.attachment }));
			this.selectedPreferenceByBoxId.set(staged.boxId, staged.attachment.selectedResultIndex);
		}
		this.canonicalAuthorityEstablished = true;
		const executionId = normalize(staged.terminal.executionId);
		if (executionId) {
			setBounded(
				this.assignmentByExecution,
				`${staged.boxId}\u0000${executionId}`,
				staged.terminal.resultArtifactAssignment,
			);
		}
		return true;
	}

	abort(panelId: string, publicationId: string): void {
		const staged = this.stagedByPublicationId.get(publicationId);
		if (staged?.panelId === panelId) this.stagedByPublicationId.delete(publicationId);
	}

	clearForExecution(boxId: string): void {
		this.ownerMutationRevision++;
		this.committedByBoxId.delete(boxId);
		this.attachmentOwnerPanelByBoxId.delete(boxId);
		this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed' }));
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (staged.boxId === boxId) this.stagedByPublicationId.delete(publicationId);
		}
	}

	revokeBox(boxId: string): void {
		this.clearForExecution(boxId);
		this.selectedPreferenceByBoxId.delete(boxId);
	}

	revokeConnections(connectionIds: ReadonlySet<string>): void {
		if (connectionIds.size === 0) return;
		const revisionBeforeRevocation = this.ownerMutationRevision;
		for (const [boxId, attachment] of [...this.committedByBoxId]) {
			if (connectionIds.has(attachment.connectionId)) this.revokeBox(boxId);
		}
		for (const [boxId, canonical] of [...this.canonicalSections]) {
			if (canonical.kind !== 'inert' || !canonical.target) continue;
			const connectionId = normalize(canonical.target.connectionIdHint);
			if (connectionId && connectionIds.has(connectionId)) this.revokeBox(boxId);
		}
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (connectionIds.has(normalize(staged.terminal.connectionId))) {
				this.stagedByPublicationId.delete(publicationId);
			}
		}
		if (this.ownerMutationRevision === revisionBeforeRevocation) this.ownerMutationRevision++;
	}

	select(panelId: string, request: KustoResultSelectionRequest): KustoResultSelectionResponse {
		const session = this.panels.get(panelId);
		const target = session?.getTarget(request.boxId);
		const attachment = this.committedByBoxId.get(request.boxId);
		if (!target || !attachment
			|| target.sectionInstanceId !== request.sectionInstanceId
			|| target.targetGeneration !== request.targetGeneration
			|| attachment.resultArtifact.artifactId !== request.primaryArtifactId
			|| !Number.isSafeInteger(request.resultIndex) || request.resultIndex < 0
			|| request.resultIndex >= attachment.resultSetCount) return { accepted: false };
		const updated = Object.freeze({ ...attachment, selectedResultIndex: request.resultIndex });
		this.ownerMutationRevision++;
		this.committedByBoxId.set(request.boxId, updated);
		this.canonicalSections.set(request.boxId, Object.freeze({ kind: 'managed', attachment: updated }));
		this.selectedPreferenceByBoxId.set(request.boxId, request.resultIndex);
		return { accepted: true, resultIndex: request.resultIndex };
	}

	getCommittedSummary(boxIdInput: unknown): KustoCommittedResultSummary | undefined {
		const boxId = normalize(boxIdInput);
		const attachment = this.committedByBoxId.get(boxId);
		return attachment ? Object.freeze({
			boxId,
			executionId: attachment.executionId,
			sectionInstanceId: attachment.sectionInstanceId,
			targetGeneration: attachment.targetGeneration,
			primaryArtifactId: attachment.resultArtifact.artifactId,
			resultSetCount: attachment.resultSetCount,
			selectedResultIndex: attachment.selectedResultIndex,
		}) : undefined;
	}

	matchesCanonicalTarget(boxIdInput: unknown, target: KustoSectionLifecycleOwner): boolean {
		const boxId = normalize(boxIdInput);
		const attachment = this.committedByBoxId.get(boxId);
		if (attachment) return attachmentMatchesTarget(attachment, target);
		const canonical = this.canonicalSections.get(boxId);
		return canonical?.kind === 'inert' && !!canonical.target
			&& descriptorlessRecordMatchesTarget(canonical.target, target);
	}

	canPanelRevokeAttachment(panelId: string, boxId: string): boolean {
		const ownerPanelId = this.attachmentOwnerPanelByBoxId.get(boxId);
		if (ownerPanelId) return ownerPanelId === panelId;
		const panelsWithTarget = [...this.panels.values()].filter(session => !!session.getTarget(boxId));
		return panelsWithTarget.length === 1 && panelsWithTarget[0]?.panelId === panelId;
	}

	hasMarkerlessInertState(boxIdInput: unknown): boolean {
		const canonical = this.canonicalSections.get(normalize(boxIdInput));
		return canonical?.kind === 'inert'
			&& typeof canonical.fields.resultJson === 'string'
			&& !!canonical.fields.resultJson
			&& !Object.prototype.hasOwnProperty.call(canonical.fields, 'kustoAccountPartition')
			&& !Object.prototype.hasOwnProperty.call(canonical.fields, 'kustoLeaveNoTraceRevision');
	}

	hasCommittedAttachments(): boolean {
		return this.committedByBoxId.size > 0;
	}

	hasCanonicalResultState(): boolean {
		return this.canonicalAuthorityEstablished;
	}
}

export class KustoResultPanelSession {
	private readonly targets = new Map<string, KustoSectionLifecycleOwner>();
	private readonly activeByBoxId = new Map<string, ActiveExecution>();
	private readonly selectionResponses = new Map<string, Readonly<{
		request: KustoResultSelectionRequest;
		response: KustoResultSelectionResponse;
	}>>();
	private disposed = false;

	constructor(
		private readonly owner: KustoResultPersistenceOwner,
		readonly panelId: string,
	) {}

	openSection(boxIdInput: unknown, sectionInstanceIdInput: unknown): boolean {
		if (this.disposed) return false;
		const boxId = normalize(boxIdInput);
		const sectionInstanceId = normalize(sectionInstanceIdInput);
		if (!boxId || !sectionInstanceId) return false;
		this.targets.set(boxId, Object.freeze({ boxId, sectionInstanceId, targetGeneration: 0 }));
		return true;
	}

	adoptTarget(target: KustoSectionLifecycleOwner): boolean {
		if (this.disposed) return false;
		const current = this.targets.get(target.boxId);
		if (!current || current.sectionInstanceId !== target.sectionInstanceId
			|| !Number.isSafeInteger(target.targetGeneration) || target.targetGeneration < current.targetGeneration) return false;
		const changed = target.targetGeneration > current.targetGeneration
			|| normalize(target.connectionId) !== normalize(current.connectionId)
			|| normalize(target.database).toLowerCase() !== normalize(current.database).toLowerCase()
			|| target.connectionRevision !== current.connectionRevision
			|| normalize(target.connectionIdentityKey) !== normalize(current.connectionIdentityKey);
		if (changed) {
			const initialAdoption = current.targetGeneration === 0
				&& !normalize(current.connectionId)
				&& !normalize(current.database);
			const physicalEnrichment = target.targetGeneration === current.targetGeneration + 1
				&& normalize(target.connectionId) === normalize(current.connectionId)
				&& normalize(target.database).toLowerCase() === normalize(current.database).toLowerCase()
				&& (current.connectionRevision === undefined
					|| current.connectionRevision === target.connectionRevision)
				&& (!normalize(current.connectionIdentityKey)
					|| normalize(current.connectionIdentityKey) === normalize(target.connectionIdentityKey))
				&& Number.isSafeInteger(target.connectionRevision)
				&& !!normalize(target.connectionIdentityKey)
				&& (current.connectionRevision === undefined || !normalize(current.connectionIdentityKey));
			const freshInitialAdoption = initialAdoption && !this.owner.hasCanonicalResultState();
			if (!this.owner.hasMarkerlessInertState(target.boxId)
				&& this.owner.canPanelRevokeAttachment(this.panelId, target.boxId)
				&& ((!freshInitialAdoption && !this.owner.matchesCanonicalTarget(target.boxId, target))
				|| (!initialAdoption && !physicalEnrichment))) {
				this.owner.revokeBox(target.boxId);
			}
			this.activeByBoxId.delete(target.boxId);
		}
		this.targets.set(target.boxId, Object.freeze({ ...target }));
		this.owner.enrichDescriptorlessTargetsForRuntimeOwner(target);
		return true;
	}

	closeSection(
		boxIdInput: unknown,
		sectionInstanceIdInput: unknown,
		preserveResultAttachment = false,
	): boolean {
		const boxId = normalize(boxIdInput);
		const current = this.targets.get(boxId);
		if (!current || current.sectionInstanceId !== normalize(sectionInstanceIdInput)) return false;
		const canRevoke = !preserveResultAttachment
			&& this.owner.canPanelRevokeAttachment(this.panelId, boxId);
		this.targets.delete(boxId);
		this.activeByBoxId.delete(boxId);
		if (canRevoke) this.owner.revokeBox(boxId);
		return true;
	}

	beginExecution(value: unknown): boolean {
		if (this.disposed || !hasKustoExecutionReservation(value)) return false;
		const execution = value as ActiveExecution;
		const target = this.targets.get(execution.boxId);
		if (!target || target.sectionInstanceId !== execution.sectionInstanceId
			|| target.targetGeneration !== execution.targetGeneration
			|| normalize(target.connectionId) !== execution.connectionId
			|| normalize(target.database).toLowerCase() !== execution.database.toLowerCase()) return false;
		if (this.owner.getCommittedSummary(execution.boxId)
			&& !this.owner.canPanelRevokeAttachment(this.panelId, execution.boxId)) return false;
		this.owner.clearForExecution(execution.boxId);
		this.activeByBoxId.set(execution.boxId, Object.freeze({ ...execution }));
		return true;
	}

	stagePublication(publicationIdInput: unknown, terminal: unknown): KustoAssignedResultTerminal | undefined {
		return this.owner.stage(this.panelId, normalize(publicationIdInput), terminal);
	}

	commitPublication(publicationIdInput: unknown): boolean {
		return this.owner.commit(this.panelId, normalize(publicationIdInput));
	}

	abortPublication(publicationIdInput: unknown): void {
		this.owner.abort(this.panelId, normalize(publicationIdInput));
	}

	selectResult(request: KustoResultSelectionRequest): KustoResultSelectionResponse {
		const requestId = normalize(request.requestId);
		const replay = this.selectionResponses.get(requestId);
		if (replay) {
			return selectionRequestEquals(replay.request, request)
				? replay.response
				: { accepted: false };
		}
		const response = this.owner.select(this.panelId, request);
		if (requestId) {
			setBounded(this.selectionResponses, requestId, Object.freeze({
				request: Object.freeze({ ...request }), response: Object.freeze({ ...response }),
			}));
		}
		return response;
	}

	revokeConnections(connectionIds: readonly string[]): void {
		this.owner.revokeConnections(new Set(connectionIds.map(normalize).filter(Boolean)));
		for (const [boxId, active] of [...this.activeByBoxId]) {
			if (connectionIds.map(normalize).includes(active.connectionId)) this.activeByBoxId.delete(boxId);
		}
	}

	getActiveExecution(boxId: string): ActiveExecution | undefined {
		return this.activeByBoxId.get(boxId);
	}

	getTarget(boxId: string): KustoSectionLifecycleOwner | undefined {
		return this.targets.get(boxId);
	}

	getTargetsSnapshot(): readonly KustoSectionLifecycleOwner[] {
		return Object.freeze([...this.targets.values()]);
	}

	getCommittedSummary(boxId: unknown): KustoCommittedResultSummary | undefined {
		return this.owner.getCommittedSummary(boxId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.targets.clear();
		this.activeByBoxId.clear();
		this.selectionResponses.clear();
		this.owner.closePanel(this.panelId);
	}
}

export type KustoResultPersistenceLease = Readonly<{
	owner: KustoResultPersistenceOwner;
	release(): void;
}>;

export class KustoResultPersistenceRegistry {
	private readonly entries = new Map<string, { owner: KustoResultPersistenceOwner; references: number }>();

	acquire(documentKeyInput: unknown): KustoResultPersistenceLease {
		const documentKey = normalize(documentKeyInput);
		if (!documentKey) throw new Error('Kusto result document identity is required.');
		let entry = this.entries.get(documentKey);
		if (!entry) {
			entry = { owner: new KustoResultPersistenceOwner(documentKey), references: 0 };
			this.entries.set(documentKey, entry);
		}
		entry.references++;
		let released = false;
		return Object.freeze({
			owner: entry.owner,
			release: () => {
				if (released) return;
				released = true;
				const current = this.entries.get(documentKey);
				if (!current || current.owner !== entry!.owner) return;
				current.references--;
				if (current.references <= 0) this.entries.delete(documentKey);
			},
		});
	}

	get(documentKeyInput: unknown): KustoResultPersistenceOwner | undefined {
		return this.entries.get(normalize(documentKeyInput))?.owner;
	}

	dispose(): void {
		this.entries.clear();
	}
}