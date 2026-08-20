import {
	createDerivedResultArtifactPublication,
	createPrimaryResultArtifactIdentity,
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
import type { KustoExecutionTerminal } from './kustoExecutionCoordinator.js';

type JsonRecord = Record<string, unknown>;
type ResultState = { sections?: unknown[] };
type KustoResultTerminal = Extract<KustoExecutionTerminal, Readonly<{ result: unknown }>>;

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
	| Readonly<{ kind: 'inert'; fields: Readonly<JsonRecord> }>;

type StagedPublication = Readonly<{
	publicationId: string;
	panelId: string;
	boxId: string;
	terminal: KustoAssignedResultTerminal;
	attachment?: ResultAttachment;
}>;

type ActiveExecution = Readonly<KustoExecutionRequestIdentity & { reservationSequence: number }>;

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
	for (const key of attachmentKeys) {
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

function persistedArtifactMatchesRecordTarget(
	record: JsonRecord,
	artifact: KustoResultArtifactAssignment,
): boolean {
	const producer = artifact.producer;
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

export class KustoResultPersistenceOwner {
	private readonly panels = new Map<string, KustoResultPanelSession>();
	private readonly canonicalSections = new Map<string, CanonicalSectionState>();
	private readonly committedByBoxId = new Map<string, ResultAttachment>();
	private readonly stagedByPublicationId = new Map<string, StagedPublication>();
	private readonly assignmentByExecution = new Map<string, KustoResultArtifactAssignment>();
	private readonly nextRevisionByBoxId = new Map<string, number>();
	private readonly selectedPreferenceByBoxId = new Map<string, number>();
	private readonly ownedSourceFingerprints = new Map<string, number>();
	private ownerMutationRevision = 0;
	private lastCanonicalSourceRevision = '';
	private lastCanonicalSourceFingerprint = '';

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
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (staged.panelId === panelId) this.stagedByPublicationId.delete(publicationId);
		}
	}

	admitCanonicalSource(
		fingerprintInput: unknown,
		state: ResultState,
		sourceRevisionInput: unknown = fingerprintInput,
	): void {
		const fingerprint = normalize(fingerprintInput);
		const sourceRevision = normalize(sourceRevisionInput);
		if (!fingerprint || !sourceRevision
			|| (sourceRevision === this.lastCanonicalSourceRevision
				&& fingerprint === this.lastCanonicalSourceFingerprint)) return;
		this.lastCanonicalSourceRevision = sourceRevision;
		this.lastCanonicalSourceFingerprint = fingerprint;
		const ownedMutationRevision = this.ownedSourceFingerprints.get(fingerprint);
		if (ownedMutationRevision !== undefined) {
			this.ownedSourceFingerprints.delete(fingerprint);
			if (ownedMutationRevision === this.ownerMutationRevision) {
				return;
			}
		}
		this.ownerMutationRevision++;
		const types = sectionTypes(state);
		const nextIds = new Set<string>();
		for (const value of Array.isArray(state.sections) ? state.sections : []) {
			if (!isRecord(value) || canonicalSectionKind(value.type) !== 'query'
				|| isSqlDerivedQuery(value, types)) continue;
			const boxId = normalize(value.id);
			if (!boxId) continue;
			nextIds.add(boxId);
			const currentCommitted = this.committedByBoxId.get(boxId);
			const hasResult = typeof value.resultJson === 'string' && value.resultJson.length > 0;
			const hasAccount = typeof value.kustoAccountPartition === 'string'
				&& value.kustoAccountPartition.trim().length > 0;
			const hasRevision = Number.isSafeInteger(value.kustoLeaveNoTraceRevision)
				&& Number(value.kustoLeaveNoTraceRevision) >= 0;
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
			if (hasResult && !isRecord(value.resultArtifact)) {
				if (currentCommitted) {
					this.canonicalSections.set(boxId, Object.freeze({ kind: 'managed', attachment: currentCommitted }));
					continue;
				}
				this.canonicalSections.set(boxId, Object.freeze({
					kind: 'inert', fields: Object.freeze(attachmentFields(value)),
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
			this.selectedPreferenceByBoxId.delete(boxId);
		}
	}

	markOwnedSourceFingerprint(fingerprintInput: unknown): void {
		const fingerprint = normalize(fingerprintInput);
		if (fingerprint) setBounded(this.ownedSourceFingerprints, fingerprint, this.ownerMutationRevision);
	}

	discardOwnedSourceFingerprint(fingerprintInput: unknown): void {
		this.ownedSourceFingerprints.delete(normalize(fingerprintInput));
	}

	overlaySnapshot<T extends ResultState>(state: T): T {
		if (!Array.isArray(state.sections)) return state;
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
			if (committed) {
				next = {
					...removeAttachmentTargetFields(base),
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
			} else if (canonical?.kind === 'inert') {
				next = { ...base, ...canonical.fields };
			}
			changed = changed || JSON.stringify(next) !== JSON.stringify(value);
			return next;
		});
		return changed ? { ...state, sections } : state;
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
			this.canonicalSections.set(staged.boxId, Object.freeze({ kind: 'managed', attachment: staged.attachment }));
			this.selectedPreferenceByBoxId.set(staged.boxId, staged.attachment.selectedResultIndex);
		}
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
		for (const [boxId, attachment] of [...this.committedByBoxId]) {
			if (connectionIds.has(attachment.connectionId)) this.revokeBox(boxId);
		}
		for (const [publicationId, staged] of [...this.stagedByPublicationId]) {
			if (connectionIds.has(normalize(staged.terminal.connectionId))) {
				this.stagedByPublicationId.delete(publicationId);
			}
		}
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

	matchesCommittedTarget(boxIdInput: unknown, target: KustoSectionLifecycleOwner): boolean {
		const attachment = this.committedByBoxId.get(normalize(boxIdInput));
		return !!attachment && attachmentMatchesTarget(attachment, target);
	}

	hasCommittedAttachments(): boolean {
		return this.committedByBoxId.size > 0;
	}

	hasCanonicalResultState(): boolean {
		return this.canonicalSections.size > 0;
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
			if (!this.owner.matchesCommittedTarget(target.boxId, target)
				|| (!initialAdoption && !physicalEnrichment)) {
				this.owner.revokeBox(target.boxId);
			}
			this.activeByBoxId.delete(target.boxId);
		}
		this.targets.set(target.boxId, Object.freeze({ ...target }));
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
		this.targets.delete(boxId);
		this.activeByBoxId.delete(boxId);
		if (!preserveResultAttachment) this.owner.revokeBox(boxId);
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