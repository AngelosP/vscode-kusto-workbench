import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';

import { readCurrentSqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal } from '../sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../shared/sqlConnectionIdentity';
import type { SqlWorkbenchService } from './sqlWorkbenchService';
import { normalizeSqlServerUrl } from './sqlAuthState';

export type SqlResultOwner = Readonly<{
	connectionId: string;
	database: string;
	generation: number;
	targetSignature: string;
	principalFingerprint: string;
	revocationGeneration: number;
}>;

export type SqlIssuedOwnerToken = Readonly<{
	token: string;
	owner: SqlResultOwner;
}>;

export type SqlEditorTarget = Readonly<{
	boxId: string;
	connectionId: string;
	database?: string;
	generation: number;
}>;

export type SqlTargetAdoptionResult = 'rejected' | 'unchanged' | 'changed';

export type SqlReadyToolOwner = Readonly<{
	connectionId: string;
	database: string;
	ownerToken: string;
	generation: number;
}>;

export type SqlComparisonOwner = {
	sourceBoxId: string;
	connectionId: string;
	copilotSequence?: number;
	comparisonRequestId?: string;
};

export interface SqlEditorSessionRegistryOptions {
	context: vscode.ExtensionContext;
	sqlWorkbench: SqlWorkbenchService;
}

export function sqlResultOwnersEqual(
	left: SqlResultOwner | undefined,
	right: SqlResultOwner | undefined,
): boolean {
	return !!left && !!right
		&& left.connectionId === right.connectionId
		&& left.database === right.database
		&& left.generation === right.generation
		&& left.targetSignature === right.targetSignature
		&& left.principalFingerprint === right.principalFingerprint
		&& left.revocationGeneration === right.revocationGeneration;
}

export class SqlEditorSessionRegistry {
	private readonly connectionIdByBoxId = new Map<string, string>();
	private readonly comparisonOwnerByBoxId = new Map<string, SqlComparisonOwner>();
	private readonly databaseByBoxId = new Map<string, string>();
	private readonly targetGenerationByBoxId = new Map<string, number>();
	private readonly retiredGenerationByBoxId = new Map<string, number>();
	private readonly ownerTokenByBoxId = new Map<string, SqlIssuedOwnerToken>();

	constructor(private readonly options: SqlEditorSessionRegistryOptions) {}

	getTarget(boxId: string): SqlEditorTarget | undefined {
		const id = String(boxId || '').trim();
		const connectionId = this.connectionIdByBoxId.get(id);
		if (!id || !connectionId) return undefined;
		const database = this.databaseByBoxId.get(id);
		return Object.freeze({
			boxId: id,
			connectionId,
			...(database ? { database } : {}),
			generation: this.targetGenerationByBoxId.get(id) ?? 0,
		});
	}

	listTargets(): readonly SqlEditorTarget[] {
		return [...this.connectionIdByBoxId.keys()]
			.map(boxId => this.getTarget(boxId))
			.filter((target): target is SqlEditorTarget => !!target);
	}

	getConnectionId(boxId: string): string | undefined {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		return this.comparisonOwnerByBoxId.get(id)?.connectionId
			?? this.connectionIdByBoxId.get(id);
	}

	getDatabase(boxId: string): string | undefined {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		const sourceBoxId = this.comparisonOwnerByBoxId.get(id)?.sourceBoxId ?? id;
		return this.databaseByBoxId.get(sourceBoxId);
	}

	getGeneration(boxId: string): number {
		const id = String(boxId || '').trim();
		if (!id) return 0;
		const sourceBoxId = this.comparisonOwnerByBoxId.get(id)?.sourceBoxId ?? id;
		return this.targetGenerationByBoxId.get(sourceBoxId) ?? 0;
	}

	isTargetCurrent(boxId: string, connectionId: string, database: string | undefined, generation: number): boolean {
		const target = this.getTarget(boxId);
		return !!target
			&& target.connectionId === connectionId
			&& (database === undefined || target.database === database)
			&& target.generation === generation;
	}

	rotateTargetOwner(boxId: string): SqlEditorTarget | undefined {
		const target = this.getTarget(boxId);
		if (!target) return undefined;
		const generation = target.generation + 1;
		this.targetGenerationByBoxId.set(target.boxId, generation);
		this.ownerTokenByBoxId.delete(target.boxId);
		return Object.freeze({ ...target, generation });
	}

	removeTarget(boxId: string): SqlEditorTarget | undefined {
		const target = this.getTarget(boxId);
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		if (target) {
			const retiredGeneration = target.generation + 1;
			this.targetGenerationByBoxId.set(id, retiredGeneration);
			this.retiredGenerationByBoxId.set(id, retiredGeneration);
		}
		this.connectionIdByBoxId.delete(id);
		this.databaseByBoxId.delete(id);
		this.ownerTokenByBoxId.delete(id);
		return target;
	}

	retireTarget(
		boxId: string,
		targetGeneration: number,
		beforeOwnerChange: () => void,
	): SqlTargetAdoptionResult {
		const id = String(boxId || '').trim();
		const generation = Number(targetGeneration);
		if (!id || !Number.isSafeInteger(generation) || generation < 0) return 'rejected';

		const currentGeneration = this.targetGenerationByBoxId.get(id);
		if (currentGeneration !== undefined && generation < currentGeneration) return 'rejected';
		const hasTargetState = this.connectionIdByBoxId.has(id)
			|| this.databaseByBoxId.has(id)
			|| this.ownerTokenByBoxId.has(id);
		if (currentGeneration === generation && !hasTargetState) return 'unchanged';

		beforeOwnerChange();
		this.targetGenerationByBoxId.set(id, generation);
		this.retiredGenerationByBoxId.set(id, generation);
		this.connectionIdByBoxId.delete(id);
		this.databaseByBoxId.delete(id);
		this.ownerTokenByBoxId.delete(id);
		return 'changed';
	}

	resetRetiredTarget(boxId: string): void {
		const id = String(boxId || '').trim();
		if (!id || this.connectionIdByBoxId.has(id)) return;
		this.targetGenerationByBoxId.delete(id);
		this.retiredGenerationByBoxId.delete(id);
	}

	getComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		return this.comparisonOwnerByBoxId.get(String(boxId || '').trim());
	}

	listComparisonOwners(): readonly Readonly<{ boxId: string; owner: SqlComparisonOwner }>[] {
		return [...this.comparisonOwnerByBoxId]
			.map(([boxId, owner]) => Object.freeze({ boxId, owner }));
	}

	setComparisonOwner(boxId: string, owner: SqlComparisonOwner): void {
		const id = String(boxId || '').trim();
		if (!id) return;
		this.comparisonOwnerByBoxId.set(id, owner);
	}

	removeComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		const owner = this.comparisonOwnerByBoxId.get(id);
		this.comparisonOwnerByBoxId.delete(id);
		this.ownerTokenByBoxId.delete(id);
		return owner;
	}

	removeComparisonOwnersForSource(sourceBoxId: string): readonly string[] {
		const sourceId = String(sourceBoxId || '').trim();
		const removed: string[] = [];
		for (const { boxId, owner } of this.listComparisonOwners()) {
			if (owner.sourceBoxId !== sourceId) continue;
			this.removeComparisonOwner(boxId);
			removed.push(boxId);
		}
		return removed;
	}

	reconcileComparisonOwners(sections: unknown[]): void {
		const records = (Array.isArray(sections) ? sections : [])
			.filter((section): section is Record<string, unknown> => !!section && typeof section === 'object');
		const ids = new Set(records.map(section => String(section.id || '').trim()).filter(Boolean));
		for (const { boxId, owner } of this.listComparisonOwners()) {
			if (!ids.has(boxId) || !ids.has(owner.sourceBoxId)) this.removeComparisonOwner(boxId);
		}
		for (const section of records) {
			const comparisonBoxId = String(section.id || '').trim();
			const sourceBoxId = String(section.comparisonSourceBoxId || '').trim();
			if (!comparisonBoxId || !sourceBoxId || !ids.has(sourceBoxId)) continue;
			const source = records.find(candidate => String(candidate.id || '').trim() === sourceBoxId);
			if (String(source?.type || '') !== 'sql') continue;
			const connectionId = this.connectionIdByBoxId.get(sourceBoxId);
			if (!connectionId) continue;
			const existing = this.getComparisonOwner(comparisonBoxId);
			if (!existing || existing.sourceBoxId !== sourceBoxId || existing.connectionId !== connectionId) {
				this.setComparisonOwner(comparisonBoxId, { sourceBoxId, connectionId });
			}
		}
	}

	getIssuedOwner(boxId: string): SqlIssuedOwnerToken | undefined {
		return this.ownerTokenByBoxId.get(String(boxId || '').trim());
	}

	getOwnerToken(boxId: string): string | undefined {
		const id = String(boxId || '').trim();
		const direct = this.getIssuedOwner(id)?.token;
		if (direct) return direct;
		const sourceBoxId = this.getComparisonOwner(id)?.sourceBoxId;
		return sourceBoxId ? this.getIssuedOwner(sourceBoxId)?.token : undefined;
	}

	revokeOwnerToken(boxId: string): void {
		this.ownerTokenByBoxId.delete(String(boxId || '').trim());
	}

	getReadyToolOwner(boxId: string): SqlReadyToolOwner | undefined {
		const id = String(boxId || '').trim();
		if (!id) return undefined;
		const derivedOwner = this.getComparisonOwner(id);
		const sourceBoxId = derivedOwner?.sourceBoxId ?? id;
		const issued = this.getIssuedOwner(id) ?? this.getIssuedOwner(sourceBoxId);
		const connectionId = derivedOwner?.connectionId ?? this.connectionIdByBoxId.get(sourceBoxId);
		const database = this.databaseByBoxId.get(sourceBoxId);
		if (!issued || !connectionId || !database
			|| issued.owner.connectionId !== connectionId || issued.owner.database !== database) return undefined;
		return Object.freeze({ connectionId, database, ownerToken: issued.token, generation: issued.owner.generation });
	}

	clear(): void {
		this.connectionIdByBoxId.clear();
		this.comparisonOwnerByBoxId.clear();
		this.databaseByBoxId.clear();
		this.targetGenerationByBoxId.clear();
		this.retiredGenerationByBoxId.clear();
		this.ownerTokenByBoxId.clear();
	}

	adoptTarget(
		boxId: string,
		connectionId: string,
		database: string | undefined,
		targetGeneration: number,
		beforeOwnerChange: () => void,
	): SqlTargetAdoptionResult {
		const id = String(boxId || '').trim();
		const nextConnectionId = String(connectionId || '').trim();
		const generation = Number(targetGeneration);
		if (!id || !nextConnectionId || !Number.isSafeInteger(generation) || generation < 0) return 'rejected';

		const currentGeneration = this.targetGenerationByBoxId.get(id);
		if (currentGeneration !== undefined && generation < currentGeneration) return 'rejected';
		if (this.retiredGenerationByBoxId.get(id) === generation) return 'rejected';
		const currentConnectionId = this.connectionIdByBoxId.get(id);
		const currentDatabase = this.databaseByBoxId.get(id);
		const hasDatabase = database !== undefined;
		const nextDatabase = hasDatabase ? String(database || '').trim() : undefined;

		if (currentGeneration === generation) {
			if ((currentConnectionId && currentConnectionId !== nextConnectionId)
				|| (hasDatabase && currentDatabase !== undefined && currentDatabase !== nextDatabase)) return 'rejected';
			this.connectionIdByBoxId.set(id, nextConnectionId);
			if (hasDatabase) {
				if (nextDatabase) this.databaseByBoxId.set(id, nextDatabase);
				else this.databaseByBoxId.delete(id);
			}
			return 'unchanged';
		}

		beforeOwnerChange();
		this.targetGenerationByBoxId.set(id, generation);
		this.retiredGenerationByBoxId.delete(id);
		this.connectionIdByBoxId.set(id, nextConnectionId);
		this.ownerTokenByBoxId.delete(id);
		if (hasDatabase && nextDatabase) this.databaseByBoxId.set(id, nextDatabase);
		else this.databaseByBoxId.delete(id);
		return 'changed';
	}

	getOwner(boxId: string): SqlResultOwner | undefined {
		const directConnectionId = this.connectionIdByBoxId.get(boxId);
		const comparisonOwner = this.comparisonOwnerByBoxId.get(boxId);
		const sourceBoxId = comparisonOwner?.sourceBoxId ?? boxId;
		const connectionId = comparisonOwner?.connectionId ?? directConnectionId;
		const database = this.databaseByBoxId.get(sourceBoxId);
		if (!connectionId || !database) return undefined;

		const connection = this.options.sqlWorkbench.connectionManager.getConnection(connectionId);
		const authType = String(connection?.authType || '').trim().toLowerCase();
		const principal = authType === 'aad'
			? this.options.sqlWorkbench.serverAccountMap.getAccountsByServer()[normalizeSqlServerUrl(connection?.serverUrl || '')]
			: String(connection?.username || '').trim();
		const principalFingerprint = connection
			? sqlSchemaPrincipalFingerprintForPrincipal(connection, principal)
			: undefined;
		if (!connection || !principalFingerprint) return undefined;

		return {
			connectionId,
			database,
			generation: this.targetGenerationByBoxId.get(sourceBoxId) ?? 0,
			targetSignature: sqlConnectionTargetSignature(connection),
			principalFingerprint,
			revocationGeneration: this.options.sqlWorkbench.leaveNoTracePolicy.getRevocationGeneration(connectionId),
		};
	}

	async getCanonicalOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		await this.options.sqlWorkbench.ready();
		await this.options.sqlWorkbench.serverAccountMap.refresh();
		const owner = this.getOwner(boxId);
		if (!owner) return undefined;
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(owner.connectionId);
		if (!connection) return undefined;
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.options.context, connection);
		return principalFingerprint ? { ...owner, principalFingerprint } : undefined;
	}

	dispatchOwnerAllowed<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(expectedOwner.connectionId);
		if (!connection || sqlConnectionTargetSignature(connection) !== expectedOwner.targetSignature) {
			throw new Error('SQL result owner changed before canonical dispatch admission.');
		}
		return this.options.sqlWorkbench.dispatchSqlOwnerAllowed(
			connection,
			expectedOwner.principalFingerprint,
			expectedOwner.revocationGeneration,
			() => {
				if (!sqlResultOwnersEqual(this.getOwner(boxId), expectedOwner)) {
					throw new Error('SQL result owner changed before canonical dispatch admission.');
				}
				return dispatch();
			},
		);
	}

	dispatchOwnerProtection<T>(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(expectedOwner.connectionId);
		if (!connection || sqlConnectionTargetSignature(connection) !== expectedOwner.targetSignature) {
			throw new Error('SQL result owner changed before protected dispatch admission.');
		}
		return this.options.sqlWorkbench.dispatchSqlOwnerProtection(
			connection,
			expectedOwner.principalFingerprint,
			expectedOwner.revocationGeneration,
			expectedProtected,
			() => {
				if (!sqlResultOwnersEqual(this.getOwner(boxId), expectedOwner)) {
					throw new Error('SQL result owner changed before protected dispatch admission.');
				}
				return dispatch();
			},
		);
	}

	async assertOwnerAllowed(boxId: string, expectedOwner: SqlResultOwner): Promise<void> {
		await this.options.sqlWorkbench.assertSqlConnectionAllowed(expectedOwner.connectionId);
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(expectedOwner.connectionId);
		if (!connection || sqlConnectionTargetSignature(connection) !== expectedOwner.targetSignature) {
			throw new Error('SQL result owner changed before response admission.');
		}
		await this.options.sqlWorkbench.connectionManager.assertConnectionCurrent(connection);
		if (!sqlResultOwnersEqual(await this.getCanonicalOwner(boxId), expectedOwner)) {
			throw new Error('SQL result owner changed before response admission.');
		}
		await this.options.sqlWorkbench.assertSqlConnectionAllowed(expectedOwner.connectionId);
	}

	async assertOwnerProtection(boxId: string, expectedOwner: SqlResultOwner, expectedProtected: boolean): Promise<void> {
		await this.options.sqlWorkbench.leaveNoTracePolicy.assertProtectionMode(
			expectedOwner.connectionId,
			expectedProtected,
			expectedOwner.revocationGeneration,
		);
		const connection = this.options.sqlWorkbench.connectionManager.getConnection(expectedOwner.connectionId);
		if (!connection || sqlConnectionTargetSignature(connection) !== expectedOwner.targetSignature) {
			throw new Error('SQL result owner changed before protected response admission.');
		}
		await this.options.sqlWorkbench.connectionManager.assertConnectionCurrent(connection);
		if (!sqlResultOwnersEqual(await this.getCanonicalOwner(boxId), expectedOwner)) {
			throw new Error('SQL result owner changed before protected response admission.');
		}
		await this.options.sqlWorkbench.leaveNoTracePolicy.assertProtectionMode(
			expectedOwner.connectionId,
			expectedProtected,
			expectedOwner.revocationGeneration,
		);
	}

	async issueOwnerToken(
		boxId: string,
		expectedOwner: SqlResultOwner,
		isCurrent: () => boolean = () => true,
	): Promise<{ token: string; created: boolean }> {
		if (!isCurrent()) throw new Error('SQL owner publication changed before token issuance.');
		if (!sqlResultOwnersEqual(await this.getCanonicalOwner(boxId), expectedOwner)) {
			throw new Error('SQL result owner changed before token issuance.');
		}
		if (!isCurrent()) throw new Error('SQL owner publication changed before token issuance.');
		return this.dispatchOwnerAllowed(boxId, expectedOwner, () => {
			if (!isCurrent()) throw new Error('SQL owner publication changed before token issuance.');
			const existing = this.ownerTokenByBoxId.get(boxId);
			if (existing && sqlResultOwnersEqual(existing.owner, expectedOwner)) {
				return { token: existing.token, created: false };
			}
			const issued = { token: randomUUID(), owner: expectedOwner } satisfies SqlIssuedOwnerToken;
			this.ownerTokenByBoxId.set(boxId, issued);
			return { token: issued.token, created: true };
		});
	}

	async issueOwnerTokenProtection(
		boxId: string,
		expectedOwner: SqlResultOwner,
		expectedProtected: boolean,
		isCurrent: () => boolean = () => true,
	): Promise<{ token: string; created: boolean }> {
		if (!isCurrent()) throw new Error('SQL protected owner publication changed before token issuance.');
		if (!sqlResultOwnersEqual(await this.getCanonicalOwner(boxId), expectedOwner)) {
			throw new Error('SQL result owner changed before protected token issuance.');
		}
		if (!isCurrent()) throw new Error('SQL protected owner publication changed before token issuance.');
		return this.dispatchOwnerProtection(boxId, expectedOwner, expectedProtected, () => {
			if (!isCurrent()) throw new Error('SQL protected owner publication changed before token issuance.');
			const existing = this.ownerTokenByBoxId.get(boxId);
			if (existing && sqlResultOwnersEqual(existing.owner, expectedOwner)) {
				return { token: existing.token, created: false };
			}
			const issued = { token: randomUUID(), owner: expectedOwner } satisfies SqlIssuedOwnerToken;
			this.ownerTokenByBoxId.set(boxId, issued);
			return { token: issued.token, created: true };
		});
	}

	async assertOwnerToken(
		boxId: string,
		token: string | undefined,
	): Promise<SqlIssuedOwnerToken> {
		const issued = this.ownerTokenByBoxId.get(boxId);
		if (!issued || !token || issued.token !== token) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		await this.assertOwnerAllowed(boxId, issued.owner);
		if (this.ownerTokenByBoxId.get(boxId) !== issued) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		return issued;
	}

	async assertOwnerTokenProtection(
		boxId: string,
		token: string | undefined,
		expectedProtected: boolean,
	): Promise<SqlIssuedOwnerToken> {
		const issued = this.ownerTokenByBoxId.get(boxId);
		if (!issued || !token || issued.token !== token) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		await this.assertOwnerProtection(boxId, issued.owner, expectedProtected);
		if (this.ownerTokenByBoxId.get(boxId) !== issued) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		return issued;
	}
}