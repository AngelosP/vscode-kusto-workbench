import * as vscode from 'vscode';

import type { ConnectionManager } from './connectionManager';
import type { KustoQueryClient } from './kustoClient';
import { sqlSchemaPrincipalFingerprintForPrincipal } from './sqlEditorSchema';
import type { SqlConnectionManager } from './sqlConnectionManager';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import { normalizeSqlServerUrl } from './sql/sqlAuthState';
import type { SqlOwnerSnapshot, SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { canonicalSectionKind } from '../shared/documentSectionCapabilities';
import { resolveKustoConnection } from '../shared/kustoAuth';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import { sqlConnectionTargetSignatureMatches } from '../shared/sqlConnectionIdentity';
import type { KustoLeaveNoTracePolicySnapshot } from './kustoLeaveNoTracePolicyStore';

type PersistedResultState = { sections?: unknown[] };

export interface PersistedResultSanitizationApplicationHandler {
	readonly onDidInvalidateSqlPersistence: vscode.Event<void>;
	readonly onDidInvalidateKustoPersistence: vscode.Event<void>;
	sanitizeSqlLeaveNoTraceState<T extends PersistedResultState>(state: T): T;
	sanitizeSqlLeaveNoTraceStateFresh<T extends PersistedResultState>(state: T): Promise<T>;
	sanitizeSqlLeaveNoTraceStateFailClosed<T extends PersistedResultState>(state: T): T;
	publishSqlLeaveNoTraceStateFresh<T extends PersistedResultState, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
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
		state = this.stripLegacyResultPayloads(state);
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		this.options.sqlLifecycle.reconcileComparisonOwners(sections);
		const sectionsById = new Map(
			sections
				.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
				.map(section => [String(section.id || '').trim(), section] as const)
				.filter(([id]) => !!id),
		);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const boxId = String(record.id || '').trim();
			const sectionType = String(record.type || '');
			const persistedSourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const persistedSource = persistedSourceBoxId ? sectionsById.get(persistedSourceBoxId) : undefined;
			if (persistedSourceBoxId && !persistedSource && 'resultJson' in record) {
				changed = true;
				const clone = { ...record };
				delete clone.resultJson;
				delete clone.resultArtifact;
				return clone;
			}
			const derivedOwner = boxId ? this.options.sqlLifecycle.getComparisonOwner(boxId) : undefined;
			const persistedSqlSource = String(persistedSource?.type || '') === 'sql' ? persistedSource : undefined;
			if (sectionType !== 'sql' && !derivedOwner && !persistedSqlSource) return section;
			const connectionId = derivedOwner?.connectionId
				?? (boxId ? this.options.sqlLifecycle.getConnectionId(boxId) : undefined);
			const sourceConnectionId = persistedSourceBoxId
				? this.options.sqlLifecycle.getConnectionId(persistedSourceBoxId)
				: undefined;
			const persistedConnectionId = String(
				persistedSqlSource?.connectionIdHint || record.connectionIdHint || '',
			).trim();
			const persistedTargetSignature = String(
				persistedSqlSource?.targetSignature || record.targetSignature || '',
			);
			let restoredConnectionId: string | undefined;
			if (persistedConnectionId && persistedTargetSignature) {
				const hintedConnection = this.options.sqlConnectionManager.getConnection(persistedConnectionId);
				if (hintedConnection && sqlConnectionTargetSignatureMatches(hintedConnection, persistedTargetSignature)) {
					restoredConnectionId = hintedConnection.id;
				}
			}
			const hasPersistedOwner = !!persistedConnectionId || !!persistedTargetSignature;
			const requiresPersistedOwner = sectionType === 'sql' || !!persistedSqlSource;
			const effectiveConnectionId = requiresPersistedOwner || hasPersistedOwner
				? restoredConnectionId
				: connectionId ?? sourceConnectionId;
			const serverUrl = String(persistedSqlSource?.serverUrl || record.serverUrl || '').trim().toLowerCase();
			const protectedByRuntimeOwner = !!effectiveConnectionId
				&& this.options.sqlWorkbench.isLeaveNoTraceConnection(effectiveConnectionId);
			const protectedByRestoredServer = !effectiveConnectionId && !!serverUrl
				&& this.options.sqlConnectionManager.getConnections().some(connection =>
					this.options.sqlWorkbench.isLeaveNoTraceConnection(connection.id)
						&& String(connection.serverUrl || '').trim().toLowerCase() === serverUrl
				);
			const sqlOwnedSection = sectionType === 'sql' || !!derivedOwner || !!persistedSqlSource;
			const unresolvedPersistedOwner = sqlOwnedSection && !effectiveConnectionId;
			if ((!protectedByRuntimeOwner && !protectedByRestoredServer && !unresolvedPersistedOwner)
				|| !('resultJson' in record)) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	async sanitizeSqlLeaveNoTraceStateFresh<T extends PersistedResultState>(state: T): Promise<T> {
		state = this.stripLegacyResultPayloads(state);
		try {
			return await this.options.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
				return this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
					const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
					const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
					if (!this.hasSqlOwnedState(locallySanitized)) {
						return { acquired: true as const, value: locallySanitized };
					}
					return this.options.sqlWorkbench.tryDispatchSqlOwnerSnapshot(snapshot =>
						this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, snapshot));
				});
			});
		} catch {
			return this.stripAllSqlOwnedResults(
				this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state)),
			);
		}
	}

	sanitizeSqlLeaveNoTraceStateFailClosed<T extends PersistedResultState>(state: T): T {
		state = this.stripLegacyResultPayloads(state);
		const locallySanitized = this.stripAllKustoOwnedResults(this.sanitizeSqlLeaveNoTraceState(state));
		return this.hasSqlOwnedState(locallySanitized)
			? this.stripAllSqlOwnedResults(locallySanitized)
			: locallySanitized;
	}

	publishSqlLeaveNoTraceStateFresh<T extends PersistedResultState, R>(
		state: T,
		publish: (sanitizedState: T) => Promise<R>,
	): Promise<R> {
		state = this.stripLegacyResultPayloads(state);
		return this.options.sqlWorkbench.retrySqlOwnerSnapshotAcquisition(async () => {
			return this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(async kustoSnapshot => {
				const kustoSanitized = this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, kustoSnapshot);
				const locallySanitized = this.sanitizeSqlLeaveNoTraceState(kustoSanitized);
				if (!this.hasSqlOwnedState(locallySanitized)) {
					return { acquired: true as const, value: await publish(locallySanitized) };
				}
				return this.options.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock(async sqlSnapshot =>
					publish(this.sanitizeSqlPrincipalOwnedResultsFromSnapshot(locallySanitized, sqlSnapshot)));
			});
		});
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

	private stripLegacyResultPayloads<T extends PersistedResultState>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const canonicalType = canonicalSectionKind(record.type);
			if ((canonicalType !== 'query' && canonicalType !== 'sql')
				|| !Object.prototype.hasOwnProperty.call(record, 'result')) return section;
			changed = true;
			const clone = { ...record };
			delete clone.result;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private sanitizeKustoLeaveNoTraceStateFromSnapshot<T extends PersistedResultState>(
		state: T,
		snapshot: KustoLeaveNoTracePolicySnapshot,
	): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const protectedClusters = new Set(snapshot.clusterKeys);
		const connections = this.options.connectionManager.getConnections();
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			if (canonicalSectionKind(record.type) !== 'query') return section;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			if (sourceBoxId && String(source?.type || '') === 'sql') return section;
			const sourceOwnsComparison = !!sourceBoxId && !!source;
			const clusterUrl = String(sourceOwnsComparison ? source.clusterUrl : record.clusterUrl || '').trim();
			const database = String(sourceOwnsComparison ? source.database : record.database || '').trim();
			const authorityId = sourceOwnsComparison ? source.authorityId : record.authorityId;
			const connectionIdHint = sourceOwnsComparison ? source.connectionIdHint : record.connectionIdHint;
			const hasExplicitComparisonOwner = !!String(
				record.clusterUrl || record.authorityId || record.connectionIdHint || record.database || '',
			).trim();
			const comparisonOwnerMatches = !sourceOwnsComparison || !hasExplicitComparisonOwner || (
				kustoClusterKey(record.clusterUrl) === kustoClusterKey(source.clusterUrl)
					&& String(record.authorityId || '').trim().toLowerCase()
						=== String(source.authorityId || '').trim().toLowerCase()
					&& String(record.connectionIdHint || '').trim() === String(source.connectionIdHint || '').trim()
					&& String(record.database || '').trim().toLowerCase()
						=== String(source.database || '').trim().toLowerCase()
			);
			let ownerMatches = false;
			let currentAccountPartition = '';
			let currentLeaveNoTraceRevision = -1;
			try {
				const resolution = resolveKustoConnection(connections, {
					clusterUrl,
					authorityId,
					connectionIdHint,
				});
				ownerMatches = !!database
					&& resolution.kind === 'matched'
					&& (!String(connectionIdHint || '').trim()
						|| resolution.connection.id === String(connectionIdHint || '').trim());
				if (resolution.kind === 'matched') {
					currentAccountPartition = String(
						this.options.kustoClient.getAccountPartition(resolution.connection) || '',
					).trim();
					currentLeaveNoTraceRevision = snapshot.revocationGenerations?.[kustoClusterKey(clusterUrl)] ?? 0;
				}
			} catch {
				ownerMatches = false;
			}
			const protectedResult = snapshot.globallyBlocked || protectedClusters.has(kustoClusterKey(clusterUrl));
			const persistedAccountPartition = String(record.kustoAccountPartition || '').trim();
			const persistedLeaveNoTraceRevision = Number(record.kustoLeaveNoTraceRevision);
			const resultOwnerMatches = !!persistedAccountPartition
				&& persistedAccountPartition === currentAccountPartition
				&& Number.isSafeInteger(persistedLeaveNoTraceRevision)
				&& persistedLeaveNoTraceRevision >= 0
				&& persistedLeaveNoTraceRevision === currentLeaveNoTraceRevision;
			if (comparisonOwnerMatches && ownerMatches && resultOwnerMatches && !protectedResult) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			delete clone.kustoAccountPartition;
			delete clone.kustoLeaveNoTraceRevision;
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllKustoOwnedResults<T extends PersistedResultState>(state: T): T {
		return this.sanitizeKustoLeaveNoTraceStateFromSnapshot(state, {
			clusterKeys: [],
			globallyBlocked: true,
			version: 0,
			revocationGenerations: {},
		});
	}

	private stripOrphanedSqlPrincipalFingerprints<T extends PersistedResultState>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object') return section;
			const record = section as Record<string, unknown>;
			const orphanedArtifact = 'resultArtifact' in record && !String(record.resultJson || '');
			const orphanedSqlPrincipal = String(record.type || '') === 'sql'
				&& ('principalFingerprint' in record || 'revocationGeneration' in record)
				&& !String(record.resultJson || '');
			if (!orphanedArtifact && !orphanedSqlPrincipal) return section;
			changed = true;
			const clone = { ...record };
			if (orphanedArtifact) delete clone.resultArtifact;
			if (orphanedSqlPrincipal) {
				delete clone.principalFingerprint;
				delete clone.revocationGeneration;
			}
			return clone;
		});
		return changed ? { ...state, sections: sanitized } : state;
	}

	private stripAllSqlOwnedResults<T extends PersistedResultState>(state: T): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const sqlOwned = String(record.type || '') === 'sql'
				|| (!!sourceBoxId && (sectionTypesById.get(sourceBoxId) === 'sql'
					|| !sectionTypesById.has(sourceBoxId)));
			if (!sqlOwned) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private sanitizeSqlPrincipalOwnedResultsFromSnapshot<T extends PersistedResultState>(
		state: T,
		snapshot: SqlOwnerSnapshot,
	): T {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionsById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), section] as const));
		const connectionsById = new Map(snapshot.connections.map(connection => [connection.id, connection]));
		const protectedIds = snapshot.policy.globallyBlocked
			? new Set(snapshot.connections.map(connection => connection.id))
			: new Set(snapshot.policy.connectionIds);
		let changed = false;
		const sanitized = sections.map(section => {
			if (!section || typeof section !== 'object' || !('resultJson' in section)) return section;
			const record = section as Record<string, unknown>;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			const source = sourceBoxId ? sectionsById.get(sourceBoxId) : undefined;
			const owner = String(source?.type || '') === 'sql' ? source! : record;
			if (String(owner.type || '') !== 'sql') return section;
			const connectionId = String(owner.connectionIdHint || '').trim();
			const targetSignature = String(owner.targetSignature || '');
			const persistedPrincipalFingerprint = String(owner.principalFingerprint || '').trim();
			const persistedRevocationGeneration = Number(owner.revocationGeneration ?? 0);
			const connection = connectionsById.get(connectionId);
			let ownerMatches = !!connection
				&& !protectedIds.has(connectionId)
				&& !!targetSignature
				&& sqlConnectionTargetSignatureMatches(connection, targetSignature)
				&& Number.isSafeInteger(persistedRevocationGeneration)
				&& persistedRevocationGeneration === (snapshot.policy.revocationGenerations[connectionId] ?? 0);
			if (ownerMatches && connection) {
				const authType = String(connection.authType || '').trim().toLowerCase();
				const principal = authType === 'aad'
					? snapshot.accountsByServer[normalizeSqlServerUrl(connection.serverUrl)]
					: String(connection.username || '').trim();
				const currentPrincipalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(connection, principal);
				ownerMatches = authType === 'aad'
					? !!persistedPrincipalFingerprint
						&& persistedPrincipalFingerprint === currentPrincipalFingerprint
					: !persistedPrincipalFingerprint
						|| persistedPrincipalFingerprint === currentPrincipalFingerprint;
			}
			if (ownerMatches) return section;
			changed = true;
			const clone = { ...record };
			delete clone.resultJson;
			delete clone.resultArtifact;
			return clone;
		});
		return this.stripOrphanedSqlPrincipalFingerprints(changed ? { ...state, sections: sanitized } : state);
	}

	private hasSqlOwnedState(state: PersistedResultState): boolean {
		const sections = Array.isArray(state?.sections) ? state.sections : [];
		const sectionTypesById = new Map(sections
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object')
			.map(section => [String(section.id || '').trim(), String(section.type || '')]));
		return sections.some(section => {
			if (!section || typeof section !== 'object') return false;
			const record = section as Record<string, unknown>;
			if (String(record.type || '') === 'sql') return true;
			const sourceBoxId = String(record.comparisonSourceBoxId || '').trim();
			return !!sourceBoxId && sectionTypesById.get(sourceBoxId) === 'sql';
		});
	}
}
