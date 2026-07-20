import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { StsProcessManager } from './stsProcessManager';
import type { SqlConnection } from '../sqlConnectionManager';
import type { SqlConnectionManager } from '../sqlConnectionManager';
import type { WorkbenchLogger } from '../workbenchLogger';
import { buildStsConnectionOptions } from './stsConnectionOptions';
import { STS_METHODS, type StsConnectParams } from './stsProtocol';
import {
	assertSqlConnectionMayUseSts,
	getSqlLeaveNoTraceConnectionIds,
	isSqlLeaveNoTraceConnection,
	type SqlLeaveNoTracePolicy,
} from './sqlLeaveNoTrace';
import { sanitizeStsLogText } from './stsLogSanitizer';
import { readCurrentSqlServerAccountMap } from './sqlServerAccountMapStore';
import { normalizeSqlServerUrl } from './sqlAuthState';
import { readCurrentSqlSchemaPrincipalFingerprint, sqlSchemaPrincipalFingerprintForPrincipal } from '../sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../shared/sqlConnectionIdentity';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * STS connection details — nested `options` dictionary with lowercase keys.
 * This matches SqlToolsService's `ConnectionDetails.Options` format.
 */
interface StsPendingConnection {
	resolve: () => void;
	reject: (err: Error) => void;
}

interface StsConnectOperation {
	key: string;
	promise: Promise<void>;
}

type SqlOwnerDispatcher = <T>(
	connection: SqlConnection,
	principalFingerprint: string,
	revocationGeneration: number,
	dispatch: () => T | PromiseLike<T>,
) => Promise<T>;

/** Completion item from STS LSP response. */
interface StsCompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | { kind: string; value: string };
	insertText?: string;
	filterText?: string;
	sortText?: string;
	insertTextFormat?: number;
}

/** Hover result from STS LSP response. */
interface StsHover {
	contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
	range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** Signature help result from STS LSP response. */
interface StsSignatureHelp {
	signatures: Array<{
		label: string;
		documentation?: string | { kind: string; value: string };
		parameters?: Array<{
			label: string | [number, number];
			documentation?: string | { kind: string; value: string };
		}>;
	}>;
	activeSignature?: number;
	activeParameter?: number;
}

/** LSP diagnostic from STS. */
interface StsDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	message: string;
	severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
	source?: string;
	code?: string | number;
}

/** Monaco marker data (simplified). */
export interface StsMarkerData {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	message: string;
	severity: number; // Monaco: 1=Hint, 2=Info, 4=Warning, 8=Error
	source?: string;
}

/** Diagnostics event forwarded to webview. */
export interface StsDiagnosticsEvent {
	boxId: string;
	markers: StsMarkerData[];
	owner?: StsExpectedOwner;
}

export type StsExpectedOwner = {
	connectionId: string;
	database: string;
	targetSignature: string;
	principalFingerprint: string;
	revocationGeneration: number;
	generation?: number;
};

/** Completion result forwarded to webview. */
export interface StsCompletionResult {
	items: Array<{
		label: string;
		kind?: number;
		detail?: string;
		documentation?: string;
		insertText?: string;
		filterText?: string;
		sortText?: string;
	}>;
}

/** Hover result forwarded to webview. */
export interface StsHoverResult {
	contents: string;
	range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

/** Signature help result forwarded to webview. */
export interface StsSignatureHelpResult {
	signatures: Array<{
		label: string;
		documentation?: string;
		parameters?: Array<{ label: string | [number, number]; documentation?: string }>;
	}>;
	activeSignature: number;
	activeParameter: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class StsLanguageService {
	private readonly _process: StsProcessManager;
	private readonly _output: WorkbenchLogger;
	private readonly _connectionManager: SqlConnectionManager;
	private readonly _context: vscode.ExtensionContext;
	private readonly _docVersions = new Map<string, number>();
	private readonly _docTextByBoxId = new Map<string, string>();
	private readonly _documentUriByBoxId = new Map<string, string>();
	private readonly _boxIdByDocumentUri = new Map<string, string>();
	private _nextDocumentSerial = 0;
	private readonly _targetByBoxId = new Map<string, {
		connection: SqlConnection;
		database: string;
		principalFingerprint: string;
		generation: number;
		revocationGeneration: number;
		expectedOwner?: StsExpectedOwner;
	}>();
	private readonly _targetGenerationByBoxId = new Map<string, number>();
	private readonly _principalFingerprintByUri = new Map<string, string>();
	private readonly _expectedOwnerByDocumentUri = new Map<string, StsExpectedOwner>();
	private readonly _pendingConnections = new Map<string, StsPendingConnection>();
	private readonly _connectOperationsByUri = new Map<string, StsConnectOperation>();
	private readonly _operationCancelReasonByUri = new Map<string, Error>();
	/** Tracks the in-flight connect promise per URI so IntelliSense methods can wait for it. */
	private readonly _connectPromiseByUri = new Map<string, Promise<void>>();
	/** Resolvers for the intelliSenseReady notification — schema is loaded after this fires. */
	private readonly _intelliSenseReadyByUri = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly _intelliSenseReadyUris = new Set<string>();
	private readonly _closedUris = new Set<string>();
	private readonly _connectedUris = new Set<string>();
	private readonly _connectedTargetKeyByUri = new Map<string, string>();
	private readonly _subscriptions: vscode.Disposable[] = [];
	private readonly _sessionId: string;
	private readonly _leaveNoTracePolicy: SqlLeaveNoTracePolicy;
	private _disposed = false;
	private _diagnosticsHandler?: (event: StsDiagnosticsEvent) => void;

	constructor(
		process: StsProcessManager,
		connectionManager: SqlConnectionManager,
		context: vscode.ExtensionContext,
		output: WorkbenchLogger,
		sessionId: string = crypto.randomUUID(),
		leaveNoTracePolicy?: SqlLeaveNoTracePolicy,
		private readonly dispatchSqlOwnerAllowed?: SqlOwnerDispatcher,
	) {
		this._process = process;
		this._connectionManager = connectionManager;
		this._context = context;
		this._output = output;
		this._sessionId = sessionId;
		this._leaveNoTracePolicy = leaveNoTracePolicy ?? {
			getConnectionIds: () => getSqlLeaveNoTraceConnectionIds(context),
			getRevocationGeneration: () => 0,
			isProtected: connectionId => isSqlLeaveNoTraceConnection(context, connectionId),
			assertAllowed: async connectionId => assertSqlConnectionMayUseSts(context, connectionId),
			dispatchAllowed: async (connectionId, dispatch) => {
				assertSqlConnectionMayUseSts(context, connectionId);
				return await dispatch();
			},
			refresh: async () => getSqlLeaveNoTraceConnectionIds(context),
		};

		// Subscribe to connection completion notifications
		this._subscriptions.push(this._process.onNotification(STS_METHODS.connectComplete, (params: any) => {
			const uri = String(params?.ownerUri || '');
			const pending = this._pendingConnections.get(uri);
			if (!pending) {
				if (this._boxIdByDocumentUri.has(uri)) {
					this._output.info(`[sts-diag] Ignored stale language connection completion uri=${uri}`);
				}
				return;
			}
			this._output.info(`[sts-diag] connection/complete uri=${uri} ok=${!!params?.connectionId}`);
			this._pendingConnections.delete(uri);

			if (params?.connectionId) {
				this._connectedUris.add(uri);
				pending.resolve();
			} else {
				const errMsg = params?.messages || params?.errorMessage || 'Connection failed';
				pending.reject(new Error(String(errMsg)));
			}
		}));

		// Subscribe to IntelliSense-ready notifications — STS sends this after the schema cache is populated.
		this._subscriptions.push(this._process.onNotification('textDocument/intelliSenseReady', (params: any) => {
			const uri = String(params?.ownerUri || '');
			if (!this._boxIdByDocumentUri.has(uri)) return;
			this._output.info(`[sts-diag] intelliSenseReady uri=${uri}`);
			const pending = this._intelliSenseReadyByUri.get(uri);
			if (pending) {
				clearTimeout(pending.timer);
				this._intelliSenseReadyByUri.delete(uri);
				pending.resolve();
			} else {
				this._intelliSenseReadyUris.add(uri);
			}
		}));

		// Subscribe to diagnostics
		this._subscriptions.push(this._process.onNotification('textDocument/publishDiagnostics', (params: any) => {
			const uri = String(params?.uri || '');
			const boxId = this._uriToBoxId(uri);
			if (!boxId || !this._diagnosticsHandler) return;
			void this._admitDiagnostics(boxId, uri, params?.diagnostics || []);
		}));

		this._subscriptions.push(
			this._process.onDidEndEpoch(event => this._handleEpochEnded(event.error ?? new Error('STS process stopped'))),
			this._process.onDidStartEpoch(() => this._replayDocumentsAfterRestart()),
		);
		const policySubscription = this._leaveNoTracePolicy.onDidChange?.(change => {
			const enabled = new Set(change.invalidatedConnectionIds ?? change.enabledConnectionIds);
			for (const [boxId, target] of [...this._targetByBoxId]) {
				if (enabled.has(target.connection.id)) this.closeDocument(boxId);
			}
		});
		if (policySubscription) this._subscriptions.push(policySubscription);
	}

	// ── Document lifecycle ─────────────────────────────────────────────

	private _boxIdToUri(boxId: string): string {
		return this._documentUriByBoxId.get(boxId)
			|| `kw-sql://language/${this._sessionId}/unopened-${encodeURIComponent(boxId)}.sql`;
	}

	private _uriToBoxId(uri: string): string | null {
		return this._boxIdByDocumentUri.get(uri) ?? null;
	}

	private _nextDocumentUri(boxId: string): string {
		const serial = ++this._nextDocumentSerial;
		const uri = `kw-sql://language/${this._sessionId}/${serial}.sql`;
		this._boxIdByDocumentUri.set(uri, boxId);
		const target = this._targetByBoxId.get(boxId);
		if (target) this._principalFingerprintByUri.set(uri, target.principalFingerprint);
		if (target?.expectedOwner) this._expectedOwnerByDocumentUri.set(uri, { ...target.expectedOwner });
		return uri;
	}

	private _targetKey(uri: string, connection: SqlConnection, database: string): string {
		const effectiveDatabase = String(database || connection.database || '').trim();
		return JSON.stringify({
			uri,
			connectionId: String(connection.id || '').trim(),
			serverUrl: String(connection.serverUrl || '').trim().toLowerCase(),
			port: connection.port || '',
			authType: String(connection.authType || '').trim().toLowerCase(),
			username: connection.authType === 'sql-login' ? String(connection.username || '').trim() : '',
			database: effectiveDatabase,
		});
	}

	private _setTarget(boxId: string, connection: SqlConnection, database: string, principalFingerprint: string, expectedOwner?: StsExpectedOwner): number {
		const previous = this._targetByBoxId.get(boxId);
		const previousOwnerGeneration = Number(previous?.expectedOwner?.generation);
		const nextOwnerGeneration = Number(expectedOwner?.generation);
		if (Number.isSafeInteger(previousOwnerGeneration) && Number.isSafeInteger(nextOwnerGeneration)) {
			if (nextOwnerGeneration < previousOwnerGeneration
				|| (nextOwnerGeneration === previousOwnerGeneration
					&& !this._sameExpectedOwner(previous?.expectedOwner, expectedOwner))) {
				throw new Error('STS document owner generation was superseded.');
			}
		}
		const nextKey = this._targetKey('', connection, database);
		const previousKey = previous ? this._targetKey('', previous.connection, previous.database) : '';
		const revocationGeneration = this._leaveNoTracePolicy.getRevocationGeneration?.(connection.id) ?? 0;
		const generation = previous && previousKey === nextKey && previous.principalFingerprint === principalFingerprint
			&& previous.revocationGeneration === revocationGeneration
			? previous.generation
			: (this._targetGenerationByBoxId.get(boxId) ?? 0) + 1;
		this._targetGenerationByBoxId.set(boxId, generation);
		this._targetByBoxId.set(boxId, {
			connection, database, principalFingerprint, generation, revocationGeneration,
			...(expectedOwner ? { expectedOwner } : previous?.expectedOwner ? { expectedOwner: previous.expectedOwner } : {}),
		});
		return generation;
	}

	private _isTargetCurrent(boxId: string, target: { generation: number }): boolean {
		return !this._disposed && this._targetByBoxId.get(boxId)?.generation === target.generation;
	}

	private _sameExpectedOwner(left: StsExpectedOwner | undefined, right: StsExpectedOwner | undefined): boolean {
		return !!left && !!right
			&& left.connectionId === right.connectionId
			&& left.database === right.database
			&& left.targetSignature === right.targetSignature
			&& left.principalFingerprint === right.principalFingerprint
			&& left.revocationGeneration === right.revocationGeneration
			&& left.generation === right.generation;
	}

	private _cleanupUri(uri: string, err: Error): void {
		this._operationCancelReasonByUri.set(uri, err);
		const boxId = this._uriToBoxId(uri);
		const expectedOwner = this._expectedOwnerByDocumentUri.get(uri);
		if (boxId && expectedOwner && this._diagnosticsHandler) {
			this._diagnosticsHandler({ boxId, markers: [], owner: expectedOwner });
		}

		const pendingReady = this._intelliSenseReadyByUri.get(uri);
		if (pendingReady) {
			clearTimeout(pendingReady.timer);
			this._intelliSenseReadyByUri.delete(uri);
			pendingReady.resolve();
		}

		const pendingConnection = this._pendingConnections.get(uri);
		if (pendingConnection) {
			this._pendingConnections.delete(uri);
			pendingConnection.reject(err);
		}

		this._connectOperationsByUri.delete(uri);
		this._connectPromiseByUri.delete(uri);
		this._connectedUris.delete(uri);
		this._connectedTargetKeyByUri.delete(uri);
		this._intelliSenseReadyUris.delete(uri);
	}

	private _closeDocumentUri(boxId: string, uri: string, error: Error): void {
		if (this._closedUris.has(uri) && !this._boxIdByDocumentUri.has(uri)) return;
		const cancelIncompleteConnect = this._connectOperationsByUri.has(uri) && !this._connectedUris.has(uri);
		this._cleanupUri(uri, error);
		this._closedUris.add(uri);
		void Promise.resolve(this._process.sendNotification('textDocument/didClose', { textDocument: { uri } }))
			.catch(() => undefined);
		if (this._documentUriByBoxId.get(boxId) === uri) this._documentUriByBoxId.delete(boxId);
		this._boxIdByDocumentUri.delete(uri);
		this._principalFingerprintByUri.delete(uri);
		this._expectedOwnerByDocumentUri.delete(uri);
		if (cancelIncompleteConnect) void this._cancelConnectUri(uri);
		void this._disconnectUri(uri);
	}

	private async _replaceDocumentUri(boxId: string, previousUri: string, connection: SqlConnection): Promise<string> {
		this._closeDocumentUri(boxId, previousUri, new Error('STS document superseded'));

		const uri = this._nextDocumentUri(boxId);
		const text = this._docTextByBoxId.get(boxId) || '';
		this._documentUriByBoxId.set(boxId, uri);
		this._closedUris.delete(uri);
		this._docVersions.set(boxId, 1);
		this._output.info(`[sts-diag] reopenDocument boxId=${boxId} uri=${uri} textLen=${text.length}`);
		await this._sendGuardedNotification(connection, 'textDocument/didOpen', {
			textDocument: { uri, languageId: 'sql', version: 1, text },
		});
		return uri;
	}

	private async _abandonConnectAttempt(boxId: string, uri: string, error: Error, connectCompleted: boolean): Promise<void> {
		this._cleanupUri(uri, error);
		this._closedUris.add(uri);
		void Promise.resolve(this._process.sendNotification('textDocument/didClose', { textDocument: { uri } }))
			.catch(() => undefined);
		this._boxIdByDocumentUri.delete(uri);
		this._principalFingerprintByUri.delete(uri);
		this._expectedOwnerByDocumentUri.delete(uri);
		if (!connectCompleted) await this._cancelConnectUri(uri);
		await this._disconnectUri(uri);
		if (!this._disposed && this._documentUriByBoxId.get(boxId) === uri && this._docTextByBoxId.has(boxId)) {
			const target = this._targetByBoxId.get(boxId);
			if (target) {
				try { await this._leaveNoTracePolicy.assertAllowed(target.connection.id); } catch { return; }
			}
			const replacementUri = this._nextDocumentUri(boxId);
			this._documentUriByBoxId.set(boxId, replacementUri);
			this._closedUris.delete(replacementUri);
			this._docVersions.set(boxId, 1);
			if (target) {
				await this._sendGuardedNotification(target.connection, 'textDocument/didOpen', {
					textDocument: { uri: replacementUri, languageId: 'sql', version: 1, text: this._docTextByBoxId.get(boxId) || '' },
				});
			} else {
				await this._process.sendNotification('textDocument/didOpen', {
					textDocument: { uri: replacementUri, languageId: 'sql', version: 1, text: this._docTextByBoxId.get(boxId) || '' },
				});
			}
		}
	}

	private _assertCurrentOperation(uri: string, key: string): void {
		const current = this._connectOperationsByUri.get(uri);
		if (!current || current.key !== key || this._closedUris.has(uri)) {
			throw this._operationCancelReasonByUri.get(uri) || new Error('STS document superseded');
		}
	}

	private async _assertExpectedOwner(
		connection: SqlConnection,
		database: string,
		expectedOwner?: StsExpectedOwner,
	): Promise<void> {
		if (!expectedOwner) return;
		if (expectedOwner.connectionId !== connection.id
			|| expectedOwner.database !== database
			|| expectedOwner.targetSignature !== sqlConnectionTargetSignature(connection)
			|| expectedOwner.revocationGeneration !== (this._leaveNoTracePolicy.getRevocationGeneration?.(connection.id) ?? 0)) {
			throw new Error('SQL tool execution target changed before STS dispatch.');
		}
		await this._connectionManager.assertConnectionCurrent(connection);
		if (await readCurrentSqlSchemaPrincipalFingerprint(this._context, connection) !== expectedOwner.principalFingerprint) {
			throw new Error('SQL tool execution principal changed before STS dispatch.');
		}
	}

	async openDocument(
		boxId: string,
		text: string,
		connection: SqlConnection,
		expectedOwner?: { connectionId: string; database: string; targetSignature: string; principalFingerprint: string; revocationGeneration: number },
	): Promise<void> {
		if (this._disposed) return;
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		await this._assertExpectedOwner(connection, expectedOwner?.database ?? connection.database ?? '', expectedOwner);
		const principalFingerprint = await this._principalFingerprint(connection);
		await this._assertExpectedOwner(connection, expectedOwner?.database ?? connection.database ?? '', expectedOwner);
		const targetGeneration = this._setTarget(boxId, connection, connection.database || '', principalFingerprint, expectedOwner);
		const existingUri = this._documentUriByBoxId.get(boxId);
		if (existingUri && !this._closedUris.has(existingUri)) {
			this._closeDocumentUri(boxId, existingUri, new Error('STS document reopened'));
		}
		const uri = this._nextDocumentUri(boxId);
		this._documentUriByBoxId.set(boxId, uri);
		this._docTextByBoxId.set(boxId, text);
		this._output.info(`[sts-diag] openDocument boxId=${boxId} uri=${uri} textLen=${text.length}`);
		this._closedUris.delete(uri);
		this._docVersions.set(boxId, 1);
		await this._sendGuardedNotification(connection, 'textDocument/didOpen', {
			textDocument: { uri, languageId: 'sql', version: 1, text },
		});
		if (this._targetGenerationByBoxId.get(boxId) !== targetGeneration) throw new Error('STS document target changed while opening.');
	}

	async changeDocument(boxId: string, text: string): Promise<void> {
		if (this._disposed) return;
		const target = this._targetByBoxId.get(boxId);
		if (!target) return;
		await this._leaveNoTracePolicy.assertAllowed(target.connection.id);
		const uri = this._boxIdToUri(boxId);
		this._docTextByBoxId.set(boxId, text);
		const version = (this._docVersions.get(boxId) ?? 0) + 1;
		this._docVersions.set(boxId, version);
		await this._sendGuardedNotification(target.connection, 'textDocument/didChange', {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	closeDocument(boxId: string): void {
		const uri = this._boxIdToUri(boxId);
		this._closeDocumentUri(boxId, uri, new Error('STS document closed'));
		this._docVersions.delete(boxId);
		this._docTextByBoxId.delete(boxId);
		this._targetByBoxId.delete(boxId);
		this._targetGenerationByBoxId.set(boxId, (this._targetGenerationByBoxId.get(boxId) ?? 0) + 1);
	}

	closeDocumentForOwner(boxId: string, expectedOwner: StsExpectedOwner): boolean {
		const target = this._targetByBoxId.get(boxId);
		if (!this._sameExpectedOwner(target?.expectedOwner, expectedOwner)) return false;
		this.closeDocument(boxId);
		return true;
	}

	// ── Connection management ──────────────────────────────────────────

	async connectDocument(
		boxId: string,
		connection: SqlConnection,
		database: string,
		expectedOwner?: StsExpectedOwner,
	): Promise<void> {
		if (this._disposed) throw new Error('STS language service disposed');
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		await this._assertExpectedOwner(connection, database, expectedOwner);
		const principalFingerprint = await this._principalFingerprint(connection);
		await this._assertExpectedOwner(connection, database, expectedOwner);
		const targetGeneration = this._setTarget(boxId, connection, database, principalFingerprint, expectedOwner);
		let uri = this._boxIdToUri(boxId);
		if (this._closedUris.has(uri)) {
			throw new Error('STS document closed');
		}

		let key = this._targetKey(uri, connection, database);
		const bindUriOwner = (ownerUri: string) => {
			this._principalFingerprintByUri.set(ownerUri, principalFingerprint);
			if (expectedOwner) this._expectedOwnerByDocumentUri.set(ownerUri, { ...expectedOwner });
		};
		const existing = this._connectOperationsByUri.get(uri);
		if (existing) {
			if (existing.key === key) {
				bindUriOwner(uri);
				this._output.info(`[sts-diag] connectDocument boxId=${boxId} → duplicate connect joined`);
				return existing.promise;
			}
			uri = await this._replaceDocumentUri(boxId, uri, connection);
			key = this._targetKey(uri, connection, database);
		}
		const connectedTargetKey = this._connectedTargetKeyByUri.get(uri);
		if (connectedTargetKey) {
			if (connectedTargetKey === key) {
				bindUriOwner(uri);
				return;
			}
			uri = await this._replaceDocumentUri(boxId, uri, connection);
			key = this._targetKey(uri, connection, database);
		}
		bindUriOwner(uri);

		const fullPromise = this._connectDocumentCore(boxId, uri, key, connection, database);
		this._operationCancelReasonByUri.delete(uri);
		this._connectOperationsByUri.set(uri, { key, promise: fullPromise });
		this._connectPromiseByUri.set(uri, fullPromise);

		try {
			await fullPromise;
			if (this._targetGenerationByBoxId.get(boxId) !== targetGeneration) throw new Error('STS document target changed while connecting.');
			this._connectedTargetKeyByUri.set(uri, key);
		} finally {
			const current = this._connectOperationsByUri.get(uri);
			if (current?.promise === fullPromise) {
				this._connectOperationsByUri.delete(uri);
			}
			if (this._connectPromiseByUri.get(uri) === fullPromise) {
				this._connectPromiseByUri.delete(uri);
			}
		}
	}

	private async _connectDocumentCore(boxId: string, uri: string, key: string, connection: SqlConnection, database: string): Promise<void> {
		const built = await buildStsConnectionOptions({
			connection,
			database,
			connectionManager: this._connectionManager,
			context: this._context,
			purpose: 'language',
		});
		const options = built.options;
		if (connection.authType === 'aad') {
			await this._pinResolvedAadPrincipal(boxId, uri, connection, built.aadAccountId);
		}
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		this._assertCurrentOperation(uri, key);

		let pendingEntry: StsPendingConnection | undefined;
		const connectPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this._pendingConnections.get(uri) === pendingEntry) {
					this._pendingConnections.delete(uri);
				}
				reject(new Error('STS connection timeout'));
			}, 30000);

			pendingEntry = {
				resolve: () => { clearTimeout(timer); resolve(); },
				reject: (err) => { clearTimeout(timer); reject(err); },
			};
			this._pendingConnections.set(uri, pendingEntry);
		});
		void connectPromise.catch(() => { /* consumed by the owning connect operation */ });

		let connectSubmitted = false;
		let connectCompleted = false;
		try {
			const params: StsConnectParams = { ownerUri: uri, connection: { options } };
			this._output.info(`[sts-diag] connectDocument boxId=${boxId} auth=${options.authenticationType}`);
			connectSubmitted = true;
			await this._sendGuardedRequest<boolean>(connection, STS_METHODS.connect, params);
			this._assertCurrentOperation(uri, key);
			await connectPromise;
			connectCompleted = true;
			await this._leaveNoTracePolicy.assertAllowed(connection.id);
			this._assertCurrentOperation(uri, key);
			this._output.info(`[sts-diag] connectDocument boxId=${boxId} → CONNECTED, waiting for schema cache...`);

			// Wait for STS to load the database schema (intelliSenseReady).
			// Without this, completions return only SQL keywords — no tables/columns.
			// First schema load can take 30-60s on cold start; use a generous timeout.
			await new Promise<void>((resolve) => {
				if (this._closedUris.has(uri)) {
					resolve();
					return;
				}
				if (this._intelliSenseReadyUris.delete(uri)) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					this._output.warn(`[sts-diag] connectDocument boxId=${boxId} → intelliSenseReady timeout (120s), proceeding anyway`);
					this._intelliSenseReadyByUri.delete(uri);
					resolve();
				}, 120000);
				this._intelliSenseReadyByUri.set(uri, { resolve, timer });
			});
			await this._leaveNoTracePolicy.assertAllowed(connection.id);
			this._assertCurrentOperation(uri, key);
			this._output.info(`[sts-diag] connectDocument boxId=${boxId} → READY (schema loaded)`);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (pendingEntry && this._pendingConnections.get(uri) === pendingEntry) {
				this._pendingConnections.delete(uri);
				pendingEntry.reject(error);
				void connectPromise.catch(() => { /* handled by outer connect */ });
			}
			if (connectSubmitted) await this._abandonConnectAttempt(boxId, uri, error, connectCompleted);
			throw error;
		}
	}

	/** Wait for any in-flight connection for this boxId (max 15s). */
	private async _waitForConnection(boxId: string): Promise<void> {
		const uri = this._boxIdToUri(boxId);
		const pending = this._connectPromiseByUri.get(uri);
		if (!pending) return;
		this._output.info(`[sts-diag] _waitForConnection boxId=${boxId} — waiting for pending connect...`);
		try {
			await Promise.race([
				pending,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error('wait timeout')), 15000)),
			]);
			this._output.info(`[sts-diag] _waitForConnection boxId=${boxId} — done`);
		} catch {
			this._output.warn(`[sts-diag] _waitForConnection boxId=${boxId} — timed out or failed`);
		}
	}

	private _handleEpochEnded(error: Error): void {
		if (this._disposed) return;
		for (const [boxId, uri] of [...this._documentUriByBoxId]) {
			this._cleanupUri(uri, error);
			this._closedUris.add(uri);
			this._boxIdByDocumentUri.delete(uri);
			this._principalFingerprintByUri.delete(uri);
			this._expectedOwnerByDocumentUri.delete(uri);
		}
		this._documentUriByBoxId.clear();
	}

	private _replayDocumentsAfterRestart(): void {
		if (this._disposed) return;
		void this._replayDocumentsAfterRestartGuarded().catch(error => {
			this._output.warn(`[sts] SQL language replay failed: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
		});
	}

	private async _replayDocumentsAfterRestartGuarded(): Promise<void> {
		for (const [boxId, text] of this._docTextByBoxId) {
			try {
				const target = this._targetByBoxId.get(boxId);
				if (target) {
					try { await this._leaveNoTracePolicy.assertAllowed(target.connection.id); } catch { continue; }
					if (!this._isTargetCurrent(boxId, target)) continue;
				}
				const uri = this._nextDocumentUri(boxId);
				this._documentUriByBoxId.set(boxId, uri);
				this._closedUris.delete(uri);
				this._docVersions.set(boxId, 1);
				if (target) {
					await this._sendGuardedNotification(target.connection, 'textDocument/didOpen', {
						textDocument: { uri, languageId: 'sql', version: 1, text },
					});
					if (!this._isTargetCurrent(boxId, target)) {
						this._closeDocumentUri(boxId, uri, new Error('STS replay target superseded'));
						continue;
					}
				} else {
					await this._process.sendNotification('textDocument/didOpen', {
						textDocument: { uri, languageId: 'sql', version: 1, text },
					});
				}
				if (target) {
					if (!this._isTargetCurrent(boxId, target)) continue;
					void this.connectDocument(boxId, target.connection, target.database).catch(error => {
						this._output.warn(`[sts] Failed to reconnect SQL language document: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
					});
				}
			} catch (error) {
				this._output.warn(`[sts] Failed to replay SQL language document: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
			}
		}
	}

	private async _disconnectUri(uri: string): Promise<void> {
		try {
			await this._process.sendRequest(STS_METHODS.disconnect, { ownerUri: uri }, { timeoutMs: 5000 });
		} catch { /* connection may already be gone */ }
	}

	private async _cancelConnectUri(uri: string): Promise<void> {
		try {
			await this._process.sendRequest(STS_METHODS.cancelConnect, { ownerUri: uri }, { timeoutMs: 5000 });
		} catch { /* connect may already have ended */ }
	}

	dispose(): void {
		if (this._disposed) return;
		for (const boxId of [...this._docTextByBoxId.keys()]) this.closeDocument(boxId);
		this._disposed = true;
		this._principalFingerprintByUri.clear();
		this._expectedOwnerByDocumentUri.clear();
		this._targetGenerationByBoxId.clear();
		for (const subscription of this._subscriptions.splice(0)) subscription.dispose();
		this._diagnosticsHandler = undefined;
	}

	// ── IntelliSense requests ──────────────────────────────────────────

	private _assertRequestOwner(boxId: string, uri: string, expectedOwner: StsExpectedOwner): void {
		const target = this._targetByBoxId.get(boxId);
		if (!this._sameExpectedOwner(target?.expectedOwner, expectedOwner)
			|| !this._sameExpectedOwner(this._expectedOwnerByDocumentUri.get(uri), expectedOwner)
			|| this._documentUriByBoxId.get(boxId) !== uri
			|| this._closedUris.has(uri)) {
			throw new Error('SQL language request owner changed.');
		}
	}

	private async _logRequestDetailAllowed(
		boxId: string,
		uri: string,
		expectedOwner: StsExpectedOwner,
		log: () => void,
	): Promise<boolean> {
		const target = this._targetByBoxId.get(boxId);
		if (!target) {
			this._output.warn('[sts] Language request details suppressed after owner invalidation.');
			return false;
		}
		try {
			await this._assertExpectedOwner(target.connection, target.database, expectedOwner);
			await this._assertPrincipalCurrent(target.connection, { textDocument: { uri } });
			await this._dispatchAllowed(target.connection, { textDocument: { uri } }, () => {
				this._assertRequestOwner(boxId, uri, expectedOwner);
				log();
			});
			return true;
		} catch {
			this._output.warn('[sts] Language request details suppressed after owner invalidation.');
			return false;
		}
	}

	private async _logRequestErrorAllowed(
		boxId: string,
		uri: string,
		expectedOwner: StsExpectedOwner,
		label: string,
		error: unknown,
	): Promise<void> {
		await this._logRequestDetailAllowed(boxId, uri, expectedOwner, () => {
			this._output.error(`[sts] ${label} error: ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
		});
	}

	async getCompletions(boxId: string, line: number, column: number, expectedOwner: StsExpectedOwner): Promise<StsCompletionResult> {
		const uri = this._boxIdToUri(boxId);
		this._output.info(`[sts-diag] getCompletions boxId=${boxId} uri=${uri} L${line}:${column}`);
		try {
			this._assertRequestOwner(boxId, uri, expectedOwner);
			await this._waitForConnection(boxId);
			this._assertRequestOwner(boxId, uri, expectedOwner);
			const target = this._targetByBoxId.get(boxId);
			const result = target ? await this._sendGuardedRequest<{ items?: StsCompletionItem[] } | StsCompletionItem[] | null>(
				target.connection,
				'textDocument/completion',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 }, // Monaco is 1-based, LSP is 0-based
				},
			) : await this._process.sendRequest<{ items?: StsCompletionItem[] } | StsCompletionItem[] | null>(
				'textDocument/completion',
				{ textDocument: { uri }, position: { line: line - 1, character: column - 1 } },
			);

			this._assertRequestOwner(boxId, uri, expectedOwner);
			const items = Array.isArray(result) ? result : (result?.items || []);
			const logged = await this._logRequestDetailAllowed(boxId, uri, expectedOwner, () => {
				this._output.info(`[sts-diag] getCompletions response boxId=${boxId} rawItems=${items.length} first=${items[0]?.label || '(none)'}`);
			});
			if (!logged) return { items: [] };
			return {
				items: items.map(item => ({
					label: typeof item.label === 'string' ? item.label : String(item.label),
					kind: item.kind,
					detail: item.detail,
					documentation: this._extractDocString(item.documentation),
					insertText: item.insertText || (typeof item.label === 'string' ? item.label : undefined),
					filterText: item.filterText,
					sortText: item.sortText,
				})),
			};
		} catch (err) {
			await this._logRequestErrorAllowed(boxId, uri, expectedOwner, 'Completion', err);
			return { items: [] };
		}
	}

	async getHover(boxId: string, line: number, column: number, expectedOwner: StsExpectedOwner): Promise<StsHoverResult | null> {
		const uri = this._boxIdToUri(boxId);
		try {
			this._assertRequestOwner(boxId, uri, expectedOwner);
			await this._waitForConnection(boxId);
			this._assertRequestOwner(boxId, uri, expectedOwner);
			const target = this._targetByBoxId.get(boxId);
			const result = target ? await this._sendGuardedRequest<StsHover | null>(
				target.connection,
				'textDocument/hover',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 },
				},
			) : await this._process.sendRequest<StsHover | null>(
				'textDocument/hover',
				{ textDocument: { uri }, position: { line: line - 1, character: column - 1 } },
			);

			this._assertRequestOwner(boxId, uri, expectedOwner);
			if (!result?.contents) return null;

			const contents = this._extractMarkdownContents(result.contents);
			if (!contents) return null;

			const hoverResult: StsHoverResult = { contents };
			if (result.range) {
				hoverResult.range = {
					startLineNumber: result.range.start.line + 1,
					startColumn: result.range.start.character + 1,
					endLineNumber: result.range.end.line + 1,
					endColumn: result.range.end.character + 1,
				};
			}
			return hoverResult;
		} catch (err) {
			await this._logRequestErrorAllowed(boxId, uri, expectedOwner, 'Hover', err);
			return null;
		}
	}

	async getSignatureHelp(boxId: string, line: number, column: number, expectedOwner: StsExpectedOwner): Promise<StsSignatureHelpResult | null> {
		const uri = this._boxIdToUri(boxId);
		try {
			this._assertRequestOwner(boxId, uri, expectedOwner);
			await this._waitForConnection(boxId);
			this._assertRequestOwner(boxId, uri, expectedOwner);
			const target = this._targetByBoxId.get(boxId);
			const result = target ? await this._sendGuardedRequest<StsSignatureHelp | null>(
				target.connection,
				'textDocument/signatureHelp',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 },
				},
			) : await this._process.sendRequest<StsSignatureHelp | null>(
				'textDocument/signatureHelp',
				{ textDocument: { uri }, position: { line: line - 1, character: column - 1 } },
			);

			this._assertRequestOwner(boxId, uri, expectedOwner);
			if (!result?.signatures?.length) return null;

			return {
				signatures: result.signatures.map(sig => ({
					label: sig.label,
					documentation: this._extractDocString(sig.documentation),
					parameters: sig.parameters?.map(p => ({
						label: p.label,
						documentation: this._extractDocString(p.documentation),
					})),
				})),
				activeSignature: result.activeSignature ?? 0,
				activeParameter: result.activeParameter ?? 0,
			};
		} catch (err) {
			await this._logRequestErrorAllowed(boxId, uri, expectedOwner, 'SignatureHelp', err);
			return null;
		}
	}

	// ── Diagnostics ────────────────────────────────────────────────────

	onDiagnostics(handler: (event: StsDiagnosticsEvent) => void): void {
		this._diagnosticsHandler = handler;
	}

	private async _sendGuardedRequest<T>(connection: SqlConnection, method: string, params: unknown): Promise<T> {
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		await this._connectionManager.assertConnectionCurrent(connection);
		await this._assertPrincipalCurrent(connection, params);
		const result = await this._dispatchAllowed(connection, params, () => {
			this._assertDispatchCurrent(connection, params);
			return this._process.sendRequest<T>(method, params);
		});
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		await this._connectionManager.assertConnectionCurrent(connection);
		await this._assertPrincipalCurrent(connection, params);
		return result;
	}

	private async _sendGuardedNotification(connection: SqlConnection, method: string, params: unknown): Promise<void> {
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		await this._connectionManager.assertConnectionCurrent(connection);
		await this._assertPrincipalCurrent(connection, params);
		await this._dispatchAllowed(connection, params, () => {
			this._assertDispatchCurrent(connection, params);
			return this._process.sendNotification(method, params);
		});
	}

	private _assertDispatchCurrent(connection: SqlConnection, params: unknown): void {
		if (this._disposed) throw new Error('STS language service disposed');
		const candidate = params as { ownerUri?: unknown; textDocument?: { uri?: unknown } } | undefined;
		const uri = String(candidate?.ownerUri || candidate?.textDocument?.uri || '');
		const boxId = uri ? this._uriToBoxId(uri) : undefined;
		const target = boxId ? this._targetByBoxId.get(boxId) : undefined;
		if (!uri || !boxId || !target || target.connection.id !== connection.id
			|| this._closedUris.has(uri) || this._documentUriByBoxId.get(boxId) !== uri) {
			throw new Error('SQL language owner changed before dispatch.');
		}
	}

	private async _dispatchAllowed<T>(connection: SqlConnection, params: unknown, dispatch: () => T | PromiseLike<T>): Promise<T> {
		const candidate = params as { ownerUri?: unknown; textDocument?: { uri?: unknown } } | undefined;
		const uri = String(candidate?.ownerUri || candidate?.textDocument?.uri || '');
		const boxId = uri ? this._uriToBoxId(uri) : undefined;
		const target = boxId ? this._targetByBoxId.get(boxId) : undefined;
		const expectedRevocationGeneration = target?.revocationGeneration;
		if (expectedRevocationGeneration === undefined) throw new Error('SQL language owner is unavailable before canonical dispatch.');
		if (this.dispatchSqlOwnerAllowed) {
			if (!target?.principalFingerprint) throw new Error('SQL language principal is unavailable before canonical dispatch.');
			return this.dispatchSqlOwnerAllowed(connection, target.principalFingerprint, expectedRevocationGeneration, dispatch);
		}
		if (this._leaveNoTracePolicy.dispatchAllowed) {
			return this._leaveNoTracePolicy.dispatchAllowed(connection.id, dispatch, expectedRevocationGeneration);
		}
		await this._leaveNoTracePolicy.assertAllowed(connection.id);
		return await dispatch();
	}

	private async _admitDiagnostics(boxId: string, uri: string, diagnostics: StsDiagnostic[]): Promise<void> {
		try {
			const target = this._targetByBoxId.get(boxId);
			const expectedOwner = this._expectedOwnerByDocumentUri.get(uri);
			if (!target?.expectedOwner || !this._sameExpectedOwner(target.expectedOwner, expectedOwner)) {
				throw new Error('SQL diagnostics owner is unavailable.');
			}
			await this._dispatchAllowed(target.connection, { textDocument: { uri } }, () => {
				if (!this._isTargetCurrent(boxId, target)
					|| this._closedUris.has(uri)
					|| this._documentUriByBoxId.get(boxId) !== uri) return;
				this._diagnosticsHandler?.({
					boxId,
					markers: diagnostics.map(d => this._translateDiagnostic(d)),
					owner: expectedOwner,
				});
			});
		} catch { /* stale or unowned diagnostics are ignored */ }
	}

	private async _principalFingerprint(connection: SqlConnection): Promise<string> {
		const fingerprint = await readCurrentSqlSchemaPrincipalFingerprint(this._context, connection);
		return fingerprint || (String(connection.authType || '').trim().toLowerCase() === 'aad' ? 'aad-pending' : '');
	}

	private async _assertPrincipalCurrent(connection: SqlConnection, params?: unknown, explicitBoxId?: string): Promise<void> {
		const candidate = params as { ownerUri?: unknown; textDocument?: { uri?: unknown } } | undefined;
		const uri = String(candidate?.ownerUri || candidate?.textDocument?.uri || '');
		if (uri && this._closedUris.has(uri)) throw new Error('STS document closed');
		const boxId = explicitBoxId || (uri ? this._uriToBoxId(uri) : undefined);
		const target = boxId ? this._targetByBoxId.get(boxId) : undefined;
		const expectedPrincipal = uri ? this._principalFingerprintByUri.get(uri) : target?.principalFingerprint;
		const currentPrincipal = await this._principalFingerprint(connection);
		if (!target || target.connection.id !== connection.id || !expectedPrincipal || expectedPrincipal !== currentPrincipal) {
			throw new Error('SQL language principal changed. Reconnect before requesting schema information.');
		}
	}

	private async _pinResolvedAadPrincipal(boxId: string, uri: string, connection: SqlConnection, accountId?: string): Promise<void> {
		const normalizedAccountId = String(accountId || '').trim();
		const target = this._targetByBoxId.get(boxId);
		const expectedPrincipal = this._principalFingerprintByUri.get(uri) ?? target?.principalFingerprint;
		const resolvedPrincipal = normalizedAccountId
			? sqlSchemaPrincipalFingerprintForPrincipal(connection, normalizedAccountId) || ''
			: '';
		if (!target || target.connection.id !== connection.id || !resolvedPrincipal
			|| (expectedPrincipal !== 'aad-pending' && expectedPrincipal !== resolvedPrincipal)) {
			throw new Error('SQL language principal changed while authentication was completing.');
		}
		if (await this._principalFingerprint(connection) !== resolvedPrincipal) {
			throw new Error('SQL language principal changed while authentication was completing.');
		}
		target.principalFingerprint = resolvedPrincipal;
		this._principalFingerprintByUri.set(uri, resolvedPrincipal);
	}

	// ── Type translation helpers ───────────────────────────────────────

	private _extractDocString(doc: string | { kind: string; value: string } | undefined): string | undefined {
		if (!doc) return undefined;
		if (typeof doc === 'string') return doc;
		if (typeof doc === 'object' && 'value' in doc) return doc.value;
		return undefined;
	}

	private _extractMarkdownContents(
		contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>,
	): string | null {
		if (typeof contents === 'string') return contents || null;
		if (Array.isArray(contents)) {
			return contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n\n') || null;
		}
		if (typeof contents === 'object' && 'value' in contents) return contents.value || null;
		return null;
	}

	private _translateDiagnostic(d: StsDiagnostic): StsMarkerData {
		// LSP severity: 1=Error, 2=Warning, 3=Info, 4=Hint
		// Monaco severity: 1=Hint, 2=Info, 4=Warning, 8=Error
		let severity = 2; // Info default
		switch (d.severity) {
			case 1: severity = 8; break; // Error
			case 2: severity = 4; break; // Warning
			case 3: severity = 2; break; // Info
			case 4: severity = 1; break; // Hint
		}

		return {
			startLineNumber: d.range.start.line + 1,
			startColumn: d.range.start.character + 1,
			endLineNumber: d.range.end.line + 1,
			endColumn: d.range.end.character + 1,
			message: d.message,
			severity,
			source: d.source || 'sql-sts',
		};
	}
}
