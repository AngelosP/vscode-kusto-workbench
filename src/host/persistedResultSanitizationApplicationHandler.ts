import * as vscode from 'vscode';

import type { ConnectionManager } from './connectionManager';
import type { KustoQueryClient } from './kustoClient';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import type { SqlOwnerSnapshot, SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import type { KustoDispatchIdentity } from '../shared/kustoExecution';
import { getKustoResultSets, parseKustoResultBatch } from '../shared/kustoResultBatch';
import {
	publicationFromPersistedResultArtifact,
	type PersistedResultArtifactV1,
	type ResultArtifactPublication,
} from '../shared/resultArtifact';
import {
	sqlConnectionServerSignature,
	sqlConnectionTargetSignatureMatches,
} from '../shared/sqlConnectionIdentity';
import {
	kustoLeaveNoTracePolicyFingerprint,
	type KustoLeaveNoTracePolicySnapshot,
} from './kustoLeaveNoTracePolicyStore';

type PersistedResultState = { sections?: unknown[] };
export type KustoSanitizationContext = Readonly<{
	snapshot: KustoLeaveNoTracePolicySnapshot;
}>;
export type KustoSanitizationObserver = (
	before: PersistedResultState,
	after: PersistedResultState,
	context: KustoSanitizationContext,
) => void;

class KustoSanitizationObserverError {
	constructor(readonly cause: unknown) {}
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

export function hasPersistedResultJson(state: PersistedResultState): boolean {
	const sections = Array.isArray(state?.sections) ? state.sections : [];
	return sections.some(section => !!section
		&& typeof section === 'object'
		&& !Array.isArray(section)
		&& hasOwn(section as Record<string, unknown>, 'resultJson'));
}

function isResultSection(section: unknown): section is Record<string, unknown> {
	if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
	const kind = canonicalSectionKind((section as Record<string, unknown>).type);
	return kind === 'query' || kind === 'sql';
}

function resultPublication(section: Record<string, unknown>): ResultArtifactPublication | undefined {
	const value = section.resultArtifact;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const artifact = value as Record<string, unknown>;
	return publicationFromPersistedResultArtifact({
		version: artifact.version, artifactId: artifact.artifactId, sourceBoxId: artifact.sourceBoxId,
		revision: artifact.revision, createdAt: artifact.createdAt, producer: artifact.producer,
	}, String(section.id || '').trim());
}

function resultPayloadTargets(section: Record<string, unknown>): readonly Readonly<{ cluster: string; database?: string }>[] {
	try {
		const parsed = parseKustoResultBatch(typeof section.resultJson === 'string'
			? JSON.parse(section.resultJson) : section.result);
		if (!parsed.ok) return [];
		return getKustoResultSets(parsed.value).flatMap(result => {
			const { cluster, database } = result.metadata;
			return typeof cluster === 'string' && cluster.trim()
				? [{ cluster: cluster.trim(), ...(typeof database === 'string' ? { database: database.trim() } : {}) }]
				: [];
		});
	} catch {
		return [];
	}
}

export function hasDeferredLegacyKustoResults(state: PersistedResultState): boolean {
	const sections = Array.isArray(state?.sections) ? state.sections : [];
	const sectionsById = new Map(sections
		.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
		.map(section => [String(section.id || '').trim(), section] as const)
		.filter(([id]) => !!id));
	return sections.some(section => {
		if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
		const record = section as Record<string, unknown>;
		if (canonicalSectionKind(record.type) !== 'query'
			|| !hasOwn(record, 'resultJson')
			|| hasOwn(record, 'kustoAccountPartition')
			|| hasOwn(record, 'kustoLeaveNoTraceRevision')) return false;
		const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
		const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
		return canonicalSectionKind(source?.type) !== 'sql';
	});
}

export interface PersistedResultSanitizationApplicationHandler {
	readonly onDidInvalidateSqlPersistence: vscode.Event<void>;
	readonly onDidInvalidateKustoPersistence: vscode.Event<void>;
	sanitizeSqlLeaveNoTraceState<T extends PersistedResultState>(state: T): T;
	sanitizeSqlLeaveNoTraceStateFresh<T extends PersistedResultState>(
		state: T,
		onKustoSanitized?: KustoSanitizationObserver,
	): Promise<T>;
	sanitizeSqlLeaveNoTraceStateFailClosed<T extends PersistedResultState>(state: T): T;
	commitKustoSourceAdmissionFresh(
		expectedPolicyFingerprint: string,
		commit: () => boolean | Promise<boolean>,
	): Promise<boolean>;
	publishSqlLeaveNoTraceStateFresh<T extends PersistedResultState, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
		onKustoSanitized?: KustoSanitizationObserver,
	): Promise<R>;
	invalidateSqlPersistence(): void;
	invalidateKustoPersistence(): void;
	dispose(): void;
}

export type PersistedResultSanitizationApplicationHandlerOptions = {
	connectionManager: Pick<ConnectionManager, 'getConnections' | 'runWithLeaveNoTraceSnapshotLock'>;
	kustoClient: Pick<KustoQueryClient, 'getAccountPartition'>;
	sqlConnectionManager: Pick<SqlConnectionManager, 'getConnection' | 'getConnections'>;
	sqlLifecycle: Pick<
		SqlEditorLifecycleCoordinator,
		'reconcileComparisonOwners' | 'getComparisonOwner' | 'getConnectionId'
	>;
	sqlWorkbench: Pick<
		SqlWorkbenchService,
		'isLeaveNoTraceConnection'
		| 'retrySqlOwnerSnapshotAcquisition'
		| 'tryDispatchSqlOwnerSnapshot'
		| 'tryRunWithSqlOwnerSnapshotLock'
	>;
};

export class HostPersistedResultSanitizationApplicationHandler
	implements PersistedResultSanitizationApplicationHandler {
	private readonly sqlPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateSqlPersistence = this.sqlPersistenceInvalidationEmitter.event;
	private readonly kustoPersistenceInvalidationEmitter = new vscode.EventEmitter<void>();
	readonly onDidInvalidateKustoPersistence = this.kustoPersistenceInvalidationEmitter.event;
	private disposed = false;

	constructor(private readonly options: PersistedResultSanitizationApplicationHandlerOptions) {}

	sanitizeSqlLeaveNoTraceState<T extends PersistedResultState>(state: T): T {
		try {
			this.options.sqlLifecycle.reconcileComparisonOwners(Array.isArray(state?.sections) ? state.sections : []);
		} catch {
			return state;
		}
		return state;
	}

	async sanitizeSqlLeaveNoTraceStateFresh<T extends PersistedResultState>(
		state: T,
		onKustoSanitized?: KustoSanitizationObserver,
	): Promise<T> {
		this.sanitizeSqlLeaveNoTraceState(state);
		if (!onKustoSanitized) return state;
		try {
			return await this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async snapshot => {
				try {
					onKustoSanitized(state, state, { snapshot });
				} catch (error) {
					throw new KustoSanitizationObserverError(error);
				}
				return state;
			});
		} catch (error) {
			if (error instanceof KustoSanitizationObserverError) throw error.cause;
			return state;
		}
	}

	sanitizeSqlLeaveNoTraceStateFailClosed<T extends PersistedResultState>(state: T): T {
		return this.sanitizeSqlLeaveNoTraceState(state);
	}

	commitKustoSourceAdmissionFresh(
		expectedPolicyFingerprint: string,
		commit: () => boolean | Promise<boolean>,
	): Promise<boolean> {
		return this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async snapshot => {
			if (!expectedPolicyFingerprint
				|| kustoLeaveNoTracePolicyFingerprint(snapshot) !== expectedPolicyFingerprint) return false;
			return await commit();
		});
	}

	publishSqlLeaveNoTraceStateFresh<T extends PersistedResultState, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
		onKustoSanitized?: KustoSanitizationObserver,
	): Promise<R> {
		this.sanitizeSqlLeaveNoTraceState(state);
		const withKustoSnapshot = <Value>(dispatch: (candidate: T) => Promise<Value>): Promise<Value> =>
			this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async snapshot => {
				const protectedClusters = new Set(snapshot.clusterKeys);
				const candidate = this.filterNewResultCandidates(state, (source, allowSectionTarget) => {
					const producer = resultPublication(source)?.producer;
					if (producer?.engine === 'sql') return false;
					if (producer?.engine !== 'kusto' && canonicalSectionKind(source.type) !== 'query') {
						return allowSectionTarget ? false : undefined;
					}
					if (snapshot.globallyBlocked) return true;
					if (protectedClusters.size === 0) return false;
					const dispatch = producer?.dispatch as Partial<KustoDispatchIdentity> | undefined;
					const identityCluster = typeof dispatch?.connectionIdentityKey === 'string'
						? kustoClusterKey(dispatch.connectionIdentityKey.split('|', 1)[0])
						: '';
					const capturedCluster = identityCluster
						|| (typeof dispatch?.clusterEndpoint === 'string' ? kustoClusterKey(dispatch.clusterEndpoint) : '');
					if (capturedCluster) return protectedClusters.has(capturedCluster);
					const payloadTargets = resultPayloadTargets(source);
					if (payloadTargets.length) return payloadTargets.some(target => protectedClusters.has(kustoClusterKey(target.cluster)));
					const producingConnectionId = typeof producer?.connectionId === 'string' ? producer.connectionId.trim() : '';
					if (producingConnectionId) {
						return this.options.connectionManager.getConnections().some(connection =>
							connection.id === producingConnectionId && protectedClusters.has(kustoClusterKey(connection.clusterUrl)));
					}
					if (!allowSectionTarget) return undefined;
					const clusterKey = kustoClusterKey(source.clusterUrl);
					if (clusterKey) return protectedClusters.has(clusterKey);
					const connectionId = String(source.connectionIdHint || '').trim();
					return !!connectionId && this.options.connectionManager.getConnections().some(connection =>
						connection.id === connectionId && protectedClusters.has(kustoClusterKey(connection.clusterUrl)));
				});
				onKustoSanitized?.(state, candidate, { snapshot });
				return dispatch(candidate);
			});
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		if (!sections.some(section => isResultSection(section)
			&& (canonicalSectionKind(section.type) === 'sql' || resultPublication(section)?.producer?.engine === 'sql'))) {
			return withKustoSnapshot(publish);
		}
		return this.options.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(() =>
			withKustoSnapshot(candidate => this.options.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock(async snapshot =>
				publish(this.filterNewResultCandidates(candidate,
					(source, allowSectionTarget) => this.isSqlTargetProtected(source, snapshot, allowSectionTarget), state)))));
	}

	invalidateSqlPersistence(): void {
		if (!this.disposed) this.sqlPersistenceInvalidationEmitter.fire();
	}

	invalidateKustoPersistence(): void {
		if (!this.disposed) this.kustoPersistenceInvalidationEmitter.fire();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.sqlPersistenceInvalidationEmitter.dispose();
		this.kustoPersistenceInvalidationEmitter.dispose();
	}

	private filterNewResultCandidates<T extends PersistedResultState>(
		state: T,
		isProtected: (source: Record<string, unknown>, allowSectionTarget: boolean) => boolean | undefined,
		sourceState: PersistedResultState = state,
	): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sourceSections = Array.isArray(sourceState?.sections) ? sourceState.sections : [];
		const sectionsById = new Map<string, Record<string, unknown> | undefined>();
		const sectionsByArtifactId = new Map<string, Record<string, unknown> | undefined>();
		const publications = new Map<Record<string, unknown>, ResultArtifactPublication>();
		const comparisonSources = new Map<Record<string, unknown>, readonly string[]>();
		for (const section of sourceSections.filter(isResultSection)) {
			const id = String(section.id || '').trim();
			if (id) sectionsById.set(id, sectionsById.has(id) ? undefined : section);
			const publication = resultPublication(section);
			if (!publication?.persistedIdentity) continue;
			publications.set(section, publication);
			const artifactId = publication.persistedIdentity.artifactId;
			sectionsByArtifactId.set(artifactId, sectionsByArtifactId.has(artifactId) ? undefined : section);
			const lineage = (section.resultArtifact as PersistedResultArtifactV1).lineage;
			if (!Array.isArray(lineage)) continue;
			const sources = lineage.filter(source => source && typeof source === 'object'
				&& !Array.isArray(source) && source.role === 'comparison-source');
			if (sources.length) {
				comparisonSources.set(section, sources.flatMap(source =>
					typeof source.sourceArtifactId === 'string' && source.sourceArtifactId.trim() ? [source.sourceArtifactId.trim()] : []));
			}
		}
		const effectiveKind = (source: Record<string, unknown>, visited = new Set<Record<string, unknown>>()): 'query' | 'sql' => {
			const engine = publications.get(source)?.producer?.engine;
			if (engine === 'kusto') return 'query';
			if (engine === 'sql') return 'sql';
			if (!visited.has(source)) {
				visited.add(source);
				const sourceArtifacts = comparisonSources.get(source);
				const parent = sourceArtifacts
					? sourceArtifacts.length === 1 ? sectionsByArtifactId.get(sourceArtifacts[0]) : undefined
					: sectionsById.get(String(source.comparisonSourceBoxId || '').trim());
				if (parent) return effectiveKind(parent, visited);
			}
			return canonicalSectionKind(source.type) === 'sql' ? 'sql' : 'query';
		};
		const evaluate = (source: Record<string, unknown>, allowSectionTarget: boolean): boolean | undefined => {
			const type = effectiveKind(source);
			return isProtected(canonicalSectionKind(source.type) === type ? source : { ...source, type }, allowSectionTarget);
		};
		const fromAttachment = (source: Record<string, unknown>, visited = new Set<Record<string, unknown>>()): boolean | undefined => {
			if (visited.has(source)) return undefined;
			visited.add(source);
			const protectedResult = evaluate(source, false);
			if (protectedResult !== undefined) return protectedResult;
			const sources = comparisonSources.get(source);
			if (!sources?.length) return undefined;
			const decisions = sources.map(artifactId => {
				const parent = sectionsByArtifactId.get(artifactId);
				return parent ? fromAttachment(parent, new Set(visited)) : undefined;
			});
			return decisions.some(decision => decision === true) ? true
				: decisions.every(decision => decision === false) ? false : undefined;
		};
		const resultFields = [
			'result', 'resultJson', 'resultArtifact', 'selectedResultIndex',
			'kustoAccountPartition', 'kustoLeaveNoTraceRevision', 'principalFingerprint', 'revocationGeneration',
		];
		let changed = false;
		const candidates = sections.map((section, index) => {
			if (!isResultSection(section)) return section;
			let source = isResultSection(sourceSections[index]) ? sourceSections[index] : section;
			let protectedResult = fromAttachment(source);
			const visited = new Set<Record<string, unknown>>();
			while (protectedResult === undefined && !comparisonSources.has(source) && !visited.has(source)) {
				visited.add(source);
				const parent = sectionsById.get(String(source.comparisonSourceBoxId || '').trim());
				if (!parent) break;
				source = parent;
				protectedResult = fromAttachment(source);
			}
			if (protectedResult === undefined && !comparisonSources.has(source)) {
				const parentId = String(source.comparisonSourceBoxId || '').trim();
				const parent = sectionsById.get(parentId);
				const fallbackSources = parent && visited.has(parent) ? [...visited] : parentId ? [] : [source];
				protectedResult = fallbackSources.some(fallback => evaluate(fallback, true) === true);
			}
			const fields = protectedResult ? resultFields : ['result'];
			if (!fields.some(field => hasOwn(section, field))) return section;
			changed = true;
			const candidate = { ...section };
			for (const field of fields) delete candidate[field];
			return candidate;
		});
		return changed ? { ...state, sections: candidates } : state;
	}

	private isSqlTargetProtected(
		source: Record<string, unknown>,
		snapshot: Pick<SqlOwnerSnapshot, 'policy' | 'connections'>,
		allowSectionTarget: boolean,
	): boolean | undefined {
		const producer = resultPublication(source)?.producer;
		if (producer?.engine === 'kusto') return false;
		if (producer?.engine !== 'sql' && canonicalSectionKind(source.type) !== 'sql') return allowSectionTarget ? false : undefined;
		if (snapshot.policy.globallyBlocked) return true;
		const protectedIds = new Set(snapshot.policy.connectionIds);
		if (protectedIds.size === 0) return false;
		const producingConnectionId = typeof producer?.connectionId === 'string' ? producer.connectionId.trim() : '';
		const producingDatabase = typeof producer?.database === 'string' ? producer.database.trim() : '';
		const payloadTargets = resultPayloadTargets(source).map(target => ({
			server: sqlConnectionServerSignature({ dialect: String(source.dialect || 'mssql'), serverUrl: target.cluster }),
			database: producingDatabase || target.database,
		}));
		const producingConnection = snapshot.connections.find(connection => connection.id === producingConnectionId);
		if (producingConnectionId && (!producingConnection || !payloadTargets.length
			|| payloadTargets.every(target => target.server === sqlConnectionServerSignature(producingConnection)))) {
			if (protectedIds.has(producingConnectionId)) return true;
			if (producingConnection) return false;
		}
		if (payloadTargets.length) {
			return payloadTargets.some(target => snapshot.connections.some(connection => protectedIds.has(connection.id)
				&& sqlConnectionServerSignature(connection) === target.server
				&& (!connection.database || !target.database
					|| connection.database.trim().toLowerCase() === target.database.toLowerCase())));
		}
		if (producingConnectionId) return false;
		if (!allowSectionTarget) return undefined;
		if (protectedIds.has(String(source.connectionIdHint || '').trim())) return true;
		const signature = String(source.targetSignature || '');
		if (signature) {
			return snapshot.connections.some(connection => protectedIds.has(connection.id)
				&& sqlConnectionTargetSignatureMatches(connection, signature));
		}
		const server = sqlConnectionServerSignature({
			dialect: String(source.dialect || 'mssql'),
			serverUrl: String(source.serverUrl || ''),
			port: typeof source.port === 'number' ? source.port : undefined,
		});
		return !!server && snapshot.connections.some(connection => protectedIds.has(connection.id)
			&& sqlConnectionServerSignature(connection) === server);
	}
}
