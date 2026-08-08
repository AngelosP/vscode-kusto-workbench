import * as vscode from 'vscode';

import {
	SqlDatabaseDiscoveryOwnerError,
	type SqlDatabaseDiscoveryOwner,
	type SqlQueryClient,
} from './sqlClient';
import type { SqlConnectionManager } from './sqlConnectionManager';
import { readCurrentSqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprint } from './sqlEditorSchema';
import type { SqlDatabaseRequestTicket, SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import type { SqlWorkbenchService } from './sql/sqlWorkbenchService';
import { sanitizeStsLogText } from './sql/stsLogSanitizer';
import { isSqlStateLockContentionError } from './sql/sqlStateTransaction';
import {
	beginSqlDatabaseCacheRequest,
	getOwnedSqlDatabaseCacheEntry,
	sqlDatabaseTargetSignature,
	SQL_DATABASE_CACHE_STORAGE_KEY,
	writeOwnedSqlDatabaseCacheEntry,
} from './sqlDatabaseCache';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { WorkbenchLogger } from './workbenchLogger';

type SqlDatabaseDiscoveryMessage = Extract<IncomingWebviewMessage, {
	type: 'getSqlDatabases' | 'refreshSqlDatabases';
}>;

type SqlDiscoveryConnection = NonNullable<ReturnType<SqlConnectionManager['getConnection']>>;

export type SqlDatabaseDiscoveryCache = Readonly<{
	beginRequest: typeof beginSqlDatabaseCacheRequest;
	getOwnedEntry: typeof getOwnedSqlDatabaseCacheEntry;
	writeOwnedEntry: typeof writeOwnedSqlDatabaseCacheEntry;
}>;

export interface SqlDatabaseDiscoveryApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type SqlDatabaseDiscoveryApplicationHandlerOptions = {
	context: Pick<vscode.ExtensionContext, 'globalState'> & { globalStorageUri?: vscode.Uri };
	lifecycle: Pick<SqlEditorLifecycleCoordinator,
		| 'adoptTarget'
		| 'beginDatabaseRequest'
		| 'completeDatabaseRequest'
		| 'isDatabaseRequestCurrent'
		| 'isDatabaseSectionOwnerCurrent'
	>;
	workbench: Pick<SqlWorkbenchService,
		| 'assertSqlConnectionAllowed'
		| 'dispatchSqlOwnerAllowed'
		| 'dispatchSqlOwnerProtection'
		| 'isLeaveNoTraceConnection'
	> & {
		leaveNoTracePolicy: Pick<SqlWorkbenchService['leaveNoTracePolicy'], 'getRevocationGeneration'>;
	};
	connectionManager: Pick<SqlConnectionManager, 'assertConnectionCurrent' | 'getConnection'>;
	client: Pick<SqlQueryClient, 'getDatabasesWithIdentity'>;
	cache?: SqlDatabaseDiscoveryCache;
	waitForDeliveryRetry?: () => Promise<void>;
	postMessage: (message: Record<string, unknown>) => PromiseLike<boolean> | void;
	output: Pick<WorkbenchLogger, 'error' | 'warn'>;
};

export class HostSqlDatabaseDiscoveryApplicationHandler implements SqlDatabaseDiscoveryApplicationHandler {
	private disposed = false;
	private readonly cache: SqlDatabaseDiscoveryCache;
	private readonly waitForDeliveryRetry: () => Promise<void>;

	constructor(private readonly options: SqlDatabaseDiscoveryApplicationHandlerOptions) {
		this.cache = options.cache ?? {
			beginRequest: beginSqlDatabaseCacheRequest,
			getOwnedEntry: getOwnedSqlDatabaseCacheEntry,
			writeOwnedEntry: writeOwnedSqlDatabaseCacheEntry,
		};
		this.waitForDeliveryRetry = options.waitForDeliveryRetry
			?? (() => new Promise(resolve => setTimeout(resolve, 50)));
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'getSqlDatabases':
			case 'refreshSqlDatabases':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		if (!this.options.lifecycle.adoptTarget(
			message.boxId,
			message.sectionInstanceId,
			message.sqlConnectionId,
			undefined,
			message.targetGeneration,
		)) return Promise.resolve();
		return this.sendSqlDatabases(message, message.type === 'refreshSqlDatabases');
	}

	dispose(): void {
		this.disposed = true;
	}

	private createOwner(
		principalFingerprint: string,
		revocationGeneration: number,
		expectedProtected: boolean,
	): SqlDatabaseDiscoveryOwner {
		return Object.freeze({ principalFingerprint, revocationGeneration, expectedProtected });
	}

	private async captureStartingPrincipal(connection: SqlDiscoveryConnection): Promise<string | undefined> {
		const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this.options.context, connection);
		if (principalFingerprint) return principalFingerprint;
		return String(connection.authType || '').trim().toLowerCase() === 'aad'
			? 'aad-pending'
			: undefined;
	}

	private logError(message: string): void {
		try { this.options.output.error(message); } catch { /* Ignore logging failures. */ }
	}

	private logWarning(message: string): void {
		try { this.options.output.warn(message); } catch { /* Ignore logging failures. */ }
	}

	private showError(message: string): void {
		try { void Promise.resolve(vscode.window.showErrorMessage(message)).catch(() => undefined); } catch { /* Ignore notification failures. */ }
	}

	private showWarning(message: string): void {
		try { void Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => undefined); } catch { /* Ignore notification failures. */ }
	}

	private async deliverMessage(
		message: Record<string, unknown>,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.disposed || !isCurrent()) return false;
			try {
				if (await Promise.resolve(this.options.postMessage(message)) === true) return true;
			} catch {
				// Retry once while the exact request is still current.
			}
			if (attempt === 0) {
				try { await this.waitForDeliveryRetry(); } catch { return false; }
			}
		}
		return false;
	}

	private async deliverTerminalMessage(
		message: Record<string, unknown>,
		ticket: SqlDatabaseRequestTicket,
		isCurrent: () => boolean,
	): Promise<boolean> {
		while (!this.disposed && isCurrent()) {
			try {
				if (await Promise.resolve(this.options.postMessage(message)) === true) {
					this.options.lifecycle.completeDatabaseRequest(ticket);
					return true;
				}
			} catch {
				// Retry after the exact request remains current.
			}
			try { await this.waitForDeliveryRetry(); } catch { return false; }
		}
		return false;
	}

	private async reconcileRetiredDatabaseRequest(
		ticket: SqlDatabaseRequestTicket,
		message: Record<string, unknown>,
	): Promise<void> {
		if (this.disposed || !this.options.lifecycle.isDatabaseRequestCurrent(ticket)) return;
		await this.deliverTerminalMessage(message, ticket, () =>
			this.options.lifecycle.isDatabaseRequestCurrent(ticket));
	}

	private createRetirementMessage(message: Record<string, unknown>): Record<string, unknown> {
		return {
			type: 'sqlDatabasesError',
			requestId: message.requestId,
			targetGeneration: message.targetGeneration,
			boxId: message.boxId,
			sectionInstanceId: message.sectionInstanceId,
			sqlConnectionId: message.sqlConnectionId,
			error: 'SQL database request ownership changed. Refresh and try again.',
		};
	}

	private async postSqlConnectionMessageAllowed(
		connection: SqlDiscoveryConnection,
		owner: SqlDatabaseDiscoveryOwner,
		message: Record<string, unknown>,
		ticket: SqlDatabaseRequestTicket,
		isCurrent: () => boolean,
	): Promise<boolean> {
		if (owner.expectedProtected) {
			await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
			return false;
		}
		while (!this.disposed && isCurrent()) {
			if (this.disposed || !isCurrent()) return false;
			try {
				const delivered = await this.options.workbench.dispatchSqlOwnerAllowed(
					connection,
					owner.principalFingerprint,
					owner.revocationGeneration,
					() => {
						if (this.disposed || !isCurrent()) return false;
						try {
							return Promise.resolve(this.options.postMessage(message)).then(
								accepted => accepted === true,
								() => false,
							);
						} catch {
							return false;
						}
					},
				);
				if (delivered) {
					this.options.lifecycle.completeDatabaseRequest(ticket);
					return true;
				}
			} catch (error) {
				if (!isSqlStateLockContentionError(error)) {
					await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
					return false;
				}
			}
			try { await this.waitForDeliveryRetry(); } catch {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
				return false;
			}
		}
		await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
		return false;
	}

	private async postSqlConnectionMessageProtection(
		connection: SqlDiscoveryConnection,
		owner: SqlDatabaseDiscoveryOwner,
		message: Record<string, unknown>,
		ticket: SqlDatabaseRequestTicket,
		isCurrent: () => boolean,
	): Promise<boolean> {
		if (!owner.expectedProtected) {
			await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
			return false;
		}
		let currentOwner = owner;
		while (!this.disposed && isCurrent()) {
			if (this.disposed || !isCurrent()) return false;
			if (currentOwner.principalFingerprint === 'aad-pending') {
				try {
					const principalFingerprint = await readCurrentSqlSchemaPrincipalFingerprint(
						this.options.context,
						connection,
					);
					if (principalFingerprint) {
						currentOwner = this.createOwner(
							principalFingerprint,
							currentOwner.revocationGeneration,
							true,
						);
					}
				} catch {
					await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
					return false;
				}
			}
			try {
				const delivered = await this.options.workbench.dispatchSqlOwnerProtection(
					connection,
					currentOwner.principalFingerprint,
					currentOwner.revocationGeneration,
					true,
					() => {
						if (this.disposed || !isCurrent()) return false;
						try {
							return Promise.resolve(this.options.postMessage(message)).then(
								accepted => accepted === true,
								() => false,
							);
						} catch {
							return false;
						}
					},
				);
				if (delivered) {
					this.options.lifecycle.completeDatabaseRequest(ticket);
					return true;
				}
			} catch (error) {
				if (!isSqlStateLockContentionError(error)) {
					await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
					return false;
				}
			}
			try { await this.waitForDeliveryRetry(); } catch {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
				return false;
			}
		}
		await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage(message));
		return false;
	}

	private async logSqlConnectionErrorAllowed(
		connection: SqlDiscoveryConnection,
		owner: SqlDatabaseDiscoveryOwner,
		message: string,
		isCurrent: () => boolean,
	): Promise<void> {
		if (owner.expectedProtected) return;
		try {
			const logged = await this.options.workbench.dispatchSqlOwnerAllowed(
				connection,
				owner.principalFingerprint,
				owner.revocationGeneration,
				() => {
					if (this.disposed || !isCurrent()) return false;
					this.logError(message);
					return true;
				},
			);
			if (logged) return;
		} catch {
			// The owner changed before detailed logging admission.
		}
		this.logWarning('[sql-database] SQL database discovery failed after its owner changed.');
	}

	private async sendSqlDatabases(message: SqlDatabaseDiscoveryMessage, forceRefresh: boolean): Promise<void> {
		const { sqlConnectionId, boxId, sectionInstanceId } = message;
		const ticket = this.options.lifecycle.beginDatabaseRequest(sqlConnectionId, boxId, sectionInstanceId);
		if (!ticket) return;
		const connection = this.options.connectionManager.getConnection(sqlConnectionId);
		const { requestId, targetGeneration: generation } = ticket;
		const loadingDelivered = await this.deliverMessage({
			type: 'sqlDatabasesLoading', requestId, targetGeneration: generation,
			boxId, sectionInstanceId, sqlConnectionId,
		}, () => this.options.lifecycle.isDatabaseRequestCurrent(ticket));
		if (!loadingDelivered) {
			this.options.lifecycle.completeDatabaseRequest(ticket);
			return;
		}
		if (!this.options.lifecycle.isDatabaseRequestCurrent(ticket)) return;
		if (!connection) {
			await this.deliverTerminalMessage({
				type: 'sqlDatabasesError', requestId, targetGeneration: generation,
				boxId, sectionInstanceId, sqlConnectionId, error: 'SQL connection not found.',
			}, ticket, () => this.options.lifecycle.isDatabaseRequestCurrent(ticket));
			return;
		}
		if (this.options.workbench.isLeaveNoTraceConnection(connection.id)) {
			await this.sendProtectedSqlDatabases(
				connection, ticket, requestId, generation, boxId, sectionInstanceId, sqlConnectionId,
			);
			return;
		}
		await this.sendAllowedSqlDatabases(
			connection, ticket, requestId, generation, boxId, sectionInstanceId, sqlConnectionId, forceRefresh,
		);
	}

	private async sendProtectedSqlDatabases(
		connection: SqlDiscoveryConnection,
		ticket: SqlDatabaseRequestTicket,
		requestId: string,
		generation: number,
		boxId: string,
		sectionInstanceId: string,
		sqlConnectionId: string,
	): Promise<void> {
		const protectedGeneration = this.options.workbench.leaveNoTracePolicy.getRevocationGeneration(connection.id);
		const targetSignature = sqlDatabaseTargetSignature(connection);
		let startingPrincipal: string | undefined;
		try {
			startingPrincipal = await this.captureStartingPrincipal(connection);
		} catch {
			await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
				requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
			}));
			return;
		}
		const fallbackOwner = startingPrincipal
			? this.createOwner(startingPrincipal, protectedGeneration, true)
			: undefined;
		const isCurrent = () => {
			const current = this.options.connectionManager.getConnection(connection.id);
			return !this.disposed
				&& !!current
				&& sqlDatabaseTargetSignature(current) === targetSignature
				&& this.options.lifecycle.isDatabaseRequestCurrent(ticket)
				&& this.options.workbench.isLeaveNoTraceConnection(connection.id)
				&& this.options.workbench.leaveNoTracePolicy.getRevocationGeneration(connection.id) === protectedGeneration;
		};
		try {
			const discovery = await this.options.client.getDatabasesWithIdentity(connection);
			if (startingPrincipal && startingPrincipal !== 'aad-pending'
				&& discovery.owner.principalFingerprint !== startingPrincipal) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			if (!discovery.owner.expectedProtected
				|| discovery.owner.revocationGeneration !== protectedGeneration) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			const databases = [...discovery.databases]
				.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
			try {
				await this.postSqlConnectionMessageProtection(connection, discovery.owner, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation,
					databases, boxId, sectionInstanceId, sqlConnectionId,
				}, ticket, isCurrent);
			} catch {
				// The protected target, principal, or policy changed before data admission.
			}
		} catch (error) {
			if (!isCurrent()) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			const originalError = error instanceof SqlDatabaseDiscoveryOwnerError
				? error.originalError
				: error;
			let owner = error instanceof SqlDatabaseDiscoveryOwnerError
				? error.owner ?? fallbackOwner
				: fallbackOwner;
			if (owner && startingPrincipal && startingPrincipal !== 'aad-pending'
				&& owner.principalFingerprint !== startingPrincipal) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			if (!owner?.expectedProtected || owner.revocationGeneration !== protectedGeneration) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			const errorMessage = originalError instanceof Error ? originalError.message : String(originalError);
			try {
				const published = await this.postSqlConnectionMessageProtection(connection, owner, {
					type: 'sqlDatabasesError', requestId, targetGeneration: generation,
					boxId, sectionInstanceId, sqlConnectionId, error: errorMessage,
				}, ticket, isCurrent);
				if (published) this.logWarning('[sql-lnt] Isolated database discovery failed.');
			} catch {
				// The protected target, principal, or policy changed before error admission.
			}
		}
	}

	private async sendAllowedSqlDatabases(
		connection: SqlDiscoveryConnection,
		ticket: SqlDatabaseRequestTicket,
		requestId: string,
		generation: number,
		boxId: string,
		sectionInstanceId: string,
		sqlConnectionId: string,
		forceRefresh: boolean,
	): Promise<void> {
		const targetSignature = sqlDatabaseTargetSignature(connection);
		const startingGeneration = this.options.workbench.leaveNoTracePolicy.getRevocationGeneration(connection.id);
		let startingPrincipal: string | undefined;
		try {
			startingPrincipal = await this.captureStartingPrincipal(connection);
		} catch {
			await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
				requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
			}));
			return;
		}
		let acceptedPrincipal = startingPrincipal;
		let discoveryOwner: SqlDatabaseDiscoveryOwner | undefined;
		const getFallbackOwner = () => acceptedPrincipal && acceptedPrincipal !== 'aad-pending'
			? this.createOwner(acceptedPrincipal, startingGeneration, false)
			: undefined;
		let cacheRequest;
		try {
			cacheRequest = await this.cache.beginRequest(
				this.options.context,
				SQL_DATABASE_CACHE_STORAGE_KEY,
				connection,
			);
		} catch {
			if (!this.disposed && this.options.lifecycle.isDatabaseRequestCurrent(ticket)) {
				await this.deliverTerminalMessage({
					type: 'sqlDatabasesError', requestId, targetGeneration: generation,
					boxId, sectionInstanceId, sqlConnectionId,
					error: 'SQL connection is changing. Try again when the update completes.',
				}, ticket, () => this.options.lifecycle.isDatabaseRequestCurrent(ticket));
			}
			return;
		}
		const isCurrent = (): boolean => {
			const current = this.options.connectionManager.getConnection(connection.id);
			const ownerGeneration = discoveryOwner?.revocationGeneration ?? startingGeneration;
			return !this.disposed
				&& !!current
				&& sqlDatabaseTargetSignature(current) === targetSignature
				&& !this.options.workbench.isLeaveNoTraceConnection(connection.id)
				&& this.options.workbench.leaveNoTracePolicy.getRevocationGeneration(connection.id) === ownerGeneration
				&& this.options.lifecycle.isDatabaseRequestCurrent(ticket);
		};
		const assertCurrentOwner = async (requireEstablishedPrincipal = false): Promise<void> => {
			await this.options.workbench.assertSqlConnectionAllowed(connection.id);
			await this.options.connectionManager.assertConnectionCurrent(connection);
			const current = this.options.connectionManager.getConnection(connection.id);
			const currentPrincipal = current
				? await readCurrentSqlSchemaPrincipalFingerprint(this.options.context, current)
				: undefined;
			if (acceptedPrincipal === 'aad-pending' && currentPrincipal) {
				acceptedPrincipal = currentPrincipal;
			}
			if (!isCurrent()) throw new Error('SQL database target changed while loading.');
			if (acceptedPrincipal && acceptedPrincipal !== 'aad-pending'
				&& currentPrincipal !== acceptedPrincipal) {
				throw new Error('SQL database principal changed while loading.');
			}
			if (requireEstablishedPrincipal) {
				if (!currentPrincipal) throw new Error('SQL database identity unavailable after loading.');
				if (discoveryOwner && currentPrincipal !== discoveryOwner.principalFingerprint) {
					throw new Error('SQL database principal changed while loading.');
				}
				acceptedPrincipal = currentPrincipal;
			}
		};
		try {
			await assertCurrentOwner();
		} catch (error) {
			if (!isCurrent()) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			await this.deliverTerminalMessage({
				type: 'sqlDatabasesError', requestId, targetGeneration: generation,
				boxId, sectionInstanceId, sqlConnectionId,
				error: error instanceof Error ? error.message : String(error),
			}, ticket, isCurrent);
			return;
		}
		const isCurrentSectionOwner = () => !this.disposed
			&& this.options.lifecycle.isDatabaseSectionOwnerCurrent(ticket);
		let cachedEntry: Awaited<ReturnType<SqlDatabaseDiscoveryCache['getOwnedEntry']>>;
		try {
			cachedEntry = await this.cache.getOwnedEntry(
				this.options.context,
				SQL_DATABASE_CACHE_STORAGE_KEY,
				connection,
			);
		} catch {
			this.logWarning('[sql-database-cache] Failed to read SQL database cache; continuing with live discovery.');
		}
		const cachedBefore = cachedEntry?.databases ?? [];

		if (!forceRefresh && cachedBefore.length > 0) {
			try {
				await assertCurrentOwner();
				if (!acceptedPrincipal || acceptedPrincipal === 'aad-pending') {
					await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
						requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
					}));
					return;
				}
				const owner = this.createOwner(cachedEntry!.principalFingerprint, startingGeneration, false);
				await this.postSqlConnectionMessageAllowed(connection, owner, {
					type: 'sqlDatabasesData', requestId, targetGeneration: generation,
					databases: cachedBefore, boxId, sectionInstanceId, sqlConnectionId,
				}, ticket, isCurrent);
			} catch {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
			}
			return;
		}

		try {
			const discovery = await this.options.client.getDatabasesWithIdentity(connection);
			if (acceptedPrincipal && acceptedPrincipal !== 'aad-pending'
				&& discovery.owner.principalFingerprint !== acceptedPrincipal) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			discoveryOwner = discovery.owner;
			acceptedPrincipal = discovery.owner.principalFingerprint;
			if (discovery.owner.expectedProtected) {
				throw new Error('SQL database protection mode changed while loading.');
			}
			const sorted = [...discovery.databases]
				.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
			await assertCurrentOwner(true);
			try {
				await this.cache.writeOwnedEntry(
					this.options.context,
					SQL_DATABASE_CACHE_STORAGE_KEY,
					connection,
					discovery.owner.principalFingerprint,
					sorted,
					cacheRequest,
					() => assertCurrentOwner(),
				);
			} catch {
				await assertCurrentOwner();
				this.logWarning('[sql-database-cache] Failed to update SQL database cache; publishing current discovery without caching.');
			}
			await assertCurrentOwner();
			await this.postSqlConnectionMessageAllowed(connection, discovery.owner, {
				type: 'sqlDatabasesData', requestId, targetGeneration: generation,
				databases: sorted, boxId, sectionInstanceId, sqlConnectionId,
			}, ticket, isCurrent);
		} catch (error) {
			const originalError = error instanceof SqlDatabaseDiscoveryOwnerError
				? error.originalError
				: error;
			if (error instanceof SqlDatabaseDiscoveryOwnerError && error.owner
				&& acceptedPrincipal && acceptedPrincipal !== 'aad-pending'
				&& error.owner.principalFingerprint !== acceptedPrincipal) {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
			if (error instanceof SqlDatabaseDiscoveryOwnerError && error.owner) {
				discoveryOwner = error.owner;
				acceptedPrincipal = error.owner.principalFingerprint;
			}
			const errorMessage = originalError instanceof Error ? originalError.message : String(originalError);
			try {
				await assertCurrentOwner();
			} catch {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
				return;
			}
				const owner = cachedEntry
					? this.createOwner(cachedEntry.principalFingerprint, startingGeneration, false)
					: discoveryOwner ?? getFallbackOwner();
			if (owner && !owner.expectedProtected) {
				await this.logSqlConnectionErrorAllowed(connection, owner, [
					`[${new Date().toISOString()}] Failed to load SQL databases`,
					`  error: ${sanitizeStsLogText(errorMessage)}`,
				].join('\n'), isCurrent);
			} else {
				this.logWarning('[sql-database] SQL database discovery failed before owner admission.');
			}
			if (cachedBefore.length > 0) {
				if (!owner || owner.expectedProtected) {
					await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
						requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
					}));
					return;
				}
				try {
					const published = await this.postSqlConnectionMessageAllowed(connection, owner, {
						type: 'sqlDatabasesData', requestId, targetGeneration: generation,
						databases: cachedBefore, boxId, sectionInstanceId, sqlConnectionId,
					}, ticket, isCurrent);
					if (published) this.showWarning('Failed to refresh SQL database list. Using cached list.');
				} catch {
					// The target, principal, or policy changed before cache admission.
				}
				return;
			}

			if (owner && !owner.expectedProtected) {
				try {
					const published = await this.postSqlConnectionMessageAllowed(connection, owner, {
						type: 'sqlDatabasesError', requestId, targetGeneration: generation,
						boxId, sectionInstanceId, sqlConnectionId, error: errorMessage,
					}, ticket, isCurrent);
					if (published) this.showError(`Failed to load SQL database list: ${errorMessage}`);
				} catch {
					// The target, principal, or policy changed before error admission.
				}
			} else if (isCurrentSectionOwner() && isCurrent()) {
				await this.deliverTerminalMessage({
					type: 'sqlDatabasesError', requestId, targetGeneration: generation,
					boxId, sectionInstanceId, sqlConnectionId, error: errorMessage,
				}, ticket, isCurrent);
				this.showError(`Failed to load SQL database list: ${errorMessage}`);
			} else {
				await this.reconcileRetiredDatabaseRequest(ticket, this.createRetirementMessage({
					requestId, targetGeneration: generation, boxId, sectionInstanceId, sqlConnectionId,
				}));
			}
		}
	}
}