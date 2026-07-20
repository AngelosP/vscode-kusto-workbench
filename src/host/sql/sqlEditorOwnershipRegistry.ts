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

export type SqlComparisonOwner = {
	sourceBoxId: string;
	connectionId: string;
	copilotSequence?: number;
	comparisonRequestId?: string;
};

export interface SqlEditorOwnershipRegistryOptions {
	context: vscode.ExtensionContext;
	sqlWorkbench: SqlWorkbenchService;
	connectionIdByBoxId: Map<string, string>;
	comparisonOwnerByBoxId: Map<string, SqlComparisonOwner>;
	databaseByBoxId: Map<string, string>;
	targetGenerationByBoxId: Map<string, number>;
	ownerTokenByBoxId: Map<string, SqlIssuedOwnerToken>;
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

export class SqlEditorOwnershipRegistry {
	constructor(private readonly options: SqlEditorOwnershipRegistryOptions) {}

	matches(options: SqlEditorOwnershipRegistryOptions): boolean {
		return this.options.context === options.context
			&& this.options.sqlWorkbench === options.sqlWorkbench
			&& this.options.connectionIdByBoxId === options.connectionIdByBoxId
			&& this.options.comparisonOwnerByBoxId === options.comparisonOwnerByBoxId
			&& this.options.databaseByBoxId === options.databaseByBoxId
			&& this.options.targetGenerationByBoxId === options.targetGenerationByBoxId
			&& this.options.ownerTokenByBoxId === options.ownerTokenByBoxId;
	}

	getOwner(boxId: string): SqlResultOwner | undefined {
		const directConnectionId = this.options.connectionIdByBoxId.get(boxId);
		const comparisonOwner = this.options.comparisonOwnerByBoxId.get(boxId);
		const sourceBoxId = comparisonOwner?.sourceBoxId ?? boxId;
		const connectionId = comparisonOwner?.connectionId ?? directConnectionId;
		const database = this.options.databaseByBoxId.get(sourceBoxId);
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
			generation: this.options.targetGenerationByBoxId.get(sourceBoxId) ?? 0,
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

	async issueOwnerToken(
		boxId: string,
		expectedOwner: SqlResultOwner,
		getCanonicalOwner: (boxId: string) => Promise<SqlResultOwner | undefined>,
		dispatchOwnerAllowed: <T>(
			boxId: string,
			expectedOwner: SqlResultOwner,
			dispatch: () => T | PromiseLike<T>,
		) => Promise<T>,
	): Promise<string> {
		if (!sqlResultOwnersEqual(await getCanonicalOwner(boxId), expectedOwner)) {
			throw new Error('SQL result owner changed before token issuance.');
		}
		return dispatchOwnerAllowed(boxId, expectedOwner, () => {
			const existing = this.options.ownerTokenByBoxId.get(boxId);
			if (existing && sqlResultOwnersEqual(existing.owner, expectedOwner)) return existing.token;
			const issued = { token: randomUUID(), owner: expectedOwner } satisfies SqlIssuedOwnerToken;
			this.options.ownerTokenByBoxId.set(boxId, issued);
			return issued.token;
		});
	}

	async assertOwnerToken(
		boxId: string,
		token: string | undefined,
		assertOwnerAllowed: (boxId: string, expectedOwner: SqlResultOwner) => Promise<void>,
	): Promise<SqlIssuedOwnerToken> {
		const issued = this.options.ownerTokenByBoxId.get(boxId);
		if (!issued || !token || issued.token !== token) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		await assertOwnerAllowed(boxId, issued.owner);
		if (this.options.ownerTokenByBoxId.get(boxId) !== issued) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		return issued;
	}
}