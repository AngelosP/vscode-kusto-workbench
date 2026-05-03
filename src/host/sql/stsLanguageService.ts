import * as vscode from 'vscode';
import { StsProcessManager } from './stsProcessManager';
import type { SqlConnection } from '../sqlConnectionManager';
import type { SqlConnectionManager } from '../sqlConnectionManager';
import { resolveSqlAadAccessToken } from './sqlAuthState';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * STS connection details — nested `options` dictionary with lowercase keys.
 * This matches SqlToolsService's `ConnectionDetails.Options` format.
 */
interface StsConnectionOptions {
	server: string;
	database: string;
	authenticationType: 'AzureMFA' | 'SqlLogin';
	azureAccountToken?: string;
	user?: string;
	password?: string;
	encrypt: string;
	trustServerCertificate: boolean;
	port?: number;
	connectTimeout?: number;
}

/** STS `connection/connect` request params. */
interface StsConnectParams {
	ownerUri: string;
	connection: { options: StsConnectionOptions };
}

interface StsPendingConnection {
	resolve: () => void;
	reject: (err: Error) => void;
}

interface StsConnectOperation {
	key: string;
	promise: Promise<void>;
}

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
}

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
	private readonly _output: vscode.OutputChannel;
	private readonly _connectionManager: SqlConnectionManager;
	private readonly _context: vscode.ExtensionContext;
	private readonly _docVersions = new Map<string, number>();
	private readonly _docTextByBoxId = new Map<string, string>();
	private readonly _documentUriByBoxId = new Map<string, string>();
	private readonly _documentSerialByBoxId = new Map<string, number>();
	private readonly _pendingConnections = new Map<string, StsPendingConnection>();
	private readonly _connectOperationsByUri = new Map<string, StsConnectOperation>();
	private readonly _operationCancelReasonByUri = new Map<string, Error>();
	/** Tracks the in-flight connect promise per URI so IntelliSense methods can wait for it. */
	private readonly _connectPromiseByUri = new Map<string, Promise<void>>();
	/** Resolvers for the intelliSenseReady notification — schema is loaded after this fires. */
	private readonly _intelliSenseReadyByUri = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly _closedUris = new Set<string>();
	private _diagnosticsHandler?: (event: StsDiagnosticsEvent) => void;

	constructor(process: StsProcessManager, connectionManager: SqlConnectionManager, context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		this._process = process;
		this._connectionManager = connectionManager;
		this._context = context;
		this._output = output;

		// Subscribe to connection completion notifications
		this._process.onNotification('connection/complete', (params: any) => {
			const uri = String(params?.ownerUri || '');
			this._output.appendLine(`[sts-diag] connection/complete uri=${uri} connectionId=${params?.connectionId || '(none)'} error=${params?.errorMessage || '(none)'}`);
			const pending = this._pendingConnections.get(uri);
			if (!pending) {
				this._output.appendLine(`[sts-diag] connection/complete: no pending connection for uri=${uri} (pending: ${[...this._pendingConnections.keys()].join(', ')})`);
				return;
			}
			this._pendingConnections.delete(uri);

			if (params?.connectionId) {
				pending.resolve();
			} else {
				const errMsg = params?.messages || params?.errorMessage || 'Connection failed';
				pending.reject(new Error(String(errMsg)));
			}
		});

		// Subscribe to IntelliSense-ready notifications — STS sends this after the schema cache is populated.
		this._process.onNotification('textDocument/intelliSenseReady', (params: any) => {
			const uri = String(params?.ownerUri || '');
			this._output.appendLine(`[sts-diag] intelliSenseReady uri=${uri}`);
			const pending = this._intelliSenseReadyByUri.get(uri);
			if (pending) {
				clearTimeout(pending.timer);
				this._intelliSenseReadyByUri.delete(uri);
				pending.resolve();
			}
		});

		// Subscribe to diagnostics
		this._process.onNotification('textDocument/publishDiagnostics', (params: any) => {
			if (!this._diagnosticsHandler) return;
			const uri = String(params?.uri || '');
			const boxId = this._uriToBoxId(uri);
			if (!boxId) return;
			if (this._closedUris.has(uri) || this._documentUriByBoxId.get(boxId) !== uri) {
				this._output.appendLine(`[sts-diag] publishDiagnostics ignored stale uri=${uri} boxId=${boxId}`);
				return;
			}

			const diagnostics: StsDiagnostic[] = params?.diagnostics || [];
			const markers = diagnostics.map(d => this._translateDiagnostic(d));
			this._diagnosticsHandler({ boxId, markers });
		});
	}

	// ── Document lifecycle ─────────────────────────────────────────────

	private _boxIdToUri(boxId: string): string {
		return this._documentUriByBoxId.get(boxId) || `sql://${boxId}.sql`;
	}

	private _uriToBoxId(uri: string): string | null {
		const match = uri.match(/^sql:\/\/(.+?)(?:\.\d+)?\.sql$/);
		return match ? match[1] : null;
	}

	private _nextDocumentUri(boxId: string): string {
		const serial = (this._documentSerialByBoxId.get(boxId) || 0) + 1;
		this._documentSerialByBoxId.set(boxId, serial);
		return serial === 1 ? `sql://${boxId}.sql` : `sql://${boxId}.${serial}.sql`;
	}

	private _targetKey(uri: string, connection: SqlConnection, database: string): string {
		const effectiveDatabase = String(database || connection.database || '').trim().toLowerCase();
		return JSON.stringify({
			uri,
			connectionId: String(connection.id || '').trim(),
			serverUrl: String(connection.serverUrl || '').trim().toLowerCase(),
			port: connection.port || '',
			authType: String(connection.authType || '').trim().toLowerCase(),
			username: connection.authType === 'sql-login' ? String(connection.username || '').trim().toLowerCase() : '',
			database: effectiveDatabase,
		});
	}

	private _cleanupUri(uri: string, err: Error): void {
		this._operationCancelReasonByUri.set(uri, err);
		const boxId = this._uriToBoxId(uri);
		if (boxId && this._diagnosticsHandler) {
			this._diagnosticsHandler({ boxId, markers: [] });
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
	}

	private _replaceDocumentUri(boxId: string, previousUri: string): string {
		this._cleanupUri(previousUri, new Error('STS document superseded'));
		this._closedUris.add(previousUri);
		this._process.sendNotification('textDocument/didClose', {
			textDocument: { uri: previousUri },
		});

		const uri = this._nextDocumentUri(boxId);
		const text = this._docTextByBoxId.get(boxId) || '';
		this._documentUriByBoxId.set(boxId, uri);
		this._closedUris.delete(uri);
		this._docVersions.set(boxId, 1);
		this._output.appendLine(`[sts-diag] reopenDocument boxId=${boxId} uri=${uri} textLen=${text.length}`);
		this._process.sendNotification('textDocument/didOpen', {
			textDocument: { uri, languageId: 'sql', version: 1, text },
		});
		return uri;
	}

	private _assertCurrentOperation(uri: string, key: string): void {
		const current = this._connectOperationsByUri.get(uri);
		if (!current || current.key !== key || this._closedUris.has(uri)) {
			throw this._operationCancelReasonByUri.get(uri) || new Error('STS document superseded');
		}
	}

	openDocument(boxId: string, text: string): void {
		const existingUri = this._documentUriByBoxId.get(boxId);
		if (existingUri && !this._closedUris.has(existingUri)) {
			this._cleanupUri(existingUri, new Error('STS document reopened'));
			this._closedUris.add(existingUri);
			this._process.sendNotification('textDocument/didClose', {
				textDocument: { uri: existingUri },
			});
		}
		const uri = this._nextDocumentUri(boxId);
		this._documentUriByBoxId.set(boxId, uri);
		this._docTextByBoxId.set(boxId, text);
		this._output.appendLine(`[sts-diag] openDocument boxId=${boxId} uri=${uri} textLen=${text.length}`);
		this._closedUris.delete(uri);
		this._docVersions.set(boxId, 1);
		this._process.sendNotification('textDocument/didOpen', {
			textDocument: { uri, languageId: 'sql', version: 1, text },
		});
	}

	changeDocument(boxId: string, text: string): void {
		const uri = this._boxIdToUri(boxId);
		this._docTextByBoxId.set(boxId, text);
		const version = (this._docVersions.get(boxId) ?? 0) + 1;
		this._docVersions.set(boxId, version);
		this._process.sendNotification('textDocument/didChange', {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	closeDocument(boxId: string): void {
		const uri = this._boxIdToUri(boxId);
		this._docVersions.delete(boxId);
		this._docTextByBoxId.delete(boxId);
		this._documentUriByBoxId.delete(boxId);
		this._closedUris.add(uri);
		this._cleanupUri(uri, new Error('STS document closed'));

		this._process.sendNotification('textDocument/didClose', {
			textDocument: { uri },
		});
	}

	// ── Connection management ──────────────────────────────────────────

	async connectDocument(boxId: string, connection: SqlConnection, database: string): Promise<void> {
		let uri = this._boxIdToUri(boxId);
		if (this._closedUris.has(uri)) {
			throw new Error('STS document closed');
		}

		let key = this._targetKey(uri, connection, database);
		const existing = this._connectOperationsByUri.get(uri);
		if (existing) {
			if (existing.key === key) {
				this._output.appendLine(`[sts-diag] connectDocument boxId=${boxId} → duplicate connect joined`);
				return existing.promise;
			}
			uri = this._replaceDocumentUri(boxId, uri);
			key = this._targetKey(uri, connection, database);
		}

		const fullPromise = this._connectDocumentCore(boxId, uri, key, connection, database);
		this._operationCancelReasonByUri.delete(uri);
		this._connectOperationsByUri.set(uri, { key, promise: fullPromise });
		this._connectPromiseByUri.set(uri, fullPromise);

		try {
			await fullPromise;
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
		const options = await this._buildConnectionOptions(connection, database);
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

		try {
			const params: StsConnectParams = { ownerUri: uri, connection: { options } };
			this._output.appendLine(`[sts-diag] connectDocument boxId=${boxId} → ${connection.serverUrl}/${database} (auth=${options.authenticationType})`);
			await this._process.sendRequest<boolean>('connection/connect', params);
			this._assertCurrentOperation(uri, key);
			await connectPromise;
			this._assertCurrentOperation(uri, key);
			this._output.appendLine(`[sts-diag] connectDocument boxId=${boxId} → CONNECTED, waiting for schema cache...`);

			// Wait for STS to load the database schema (intelliSenseReady).
			// Without this, completions return only SQL keywords — no tables/columns.
			// First schema load can take 30-60s on cold start; use a generous timeout.
			await new Promise<void>((resolve) => {
				if (this._closedUris.has(uri)) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					this._output.appendLine(`[sts-diag] connectDocument boxId=${boxId} → intelliSenseReady timeout (120s), proceeding anyway`);
					this._intelliSenseReadyByUri.delete(uri);
					resolve();
				}, 120000);
				this._intelliSenseReadyByUri.set(uri, { resolve, timer });
			});
			this._assertCurrentOperation(uri, key);
			this._output.appendLine(`[sts-diag] connectDocument boxId=${boxId} → READY (schema loaded)`);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (pendingEntry && this._pendingConnections.get(uri) === pendingEntry) {
				this._pendingConnections.delete(uri);
				pendingEntry.reject(error);
				void connectPromise.catch(() => { /* handled by outer connect */ });
			}
			throw error;
		}
	}

	/** Wait for any in-flight connection for this boxId (max 15s). */
	private async _waitForConnection(boxId: string): Promise<void> {
		const uri = this._boxIdToUri(boxId);
		const pending = this._connectPromiseByUri.get(uri);
		if (!pending) return;
		this._output.appendLine(`[sts-diag] _waitForConnection boxId=${boxId} — waiting for pending connect...`);
		try {
			await Promise.race([
				pending,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error('wait timeout')), 15000)),
			]);
			this._output.appendLine(`[sts-diag] _waitForConnection boxId=${boxId} — done`);
		} catch {
			this._output.appendLine(`[sts-diag] _waitForConnection boxId=${boxId} — timed out or failed`);
		}
	}

	private async _buildConnectionOptions(connection: SqlConnection, database: string): Promise<StsConnectionOptions> {
		const serverName = connection.port
			? `${connection.serverUrl},${connection.port}`
			: connection.serverUrl;

		const options: StsConnectionOptions = {
			server: serverName,
			database: database || connection.database || '',
			authenticationType: connection.authType === 'aad' ? 'AzureMFA' : 'SqlLogin',
			encrypt: 'Mandatory',
			trustServerCertificate: true,
			connectTimeout: 15,
		};

		if (connection.authType === 'aad') {
			const resolved = await resolveSqlAadAccessToken(this._context, connection.serverUrl);
			if (resolved.token) {
				options.azureAccountToken = resolved.token;
			}
		} else {
			options.user = connection.username || '';
			const password = await this._connectionManager.getPassword(connection.id);
			options.password = password || '';
		}

		return options;
	}

	// ── IntelliSense requests ──────────────────────────────────────────

	async getCompletions(boxId: string, line: number, column: number): Promise<StsCompletionResult> {
		const uri = this._boxIdToUri(boxId);
		this._output.appendLine(`[sts-diag] getCompletions boxId=${boxId} uri=${uri} L${line}:${column}`);
		await this._waitForConnection(boxId);
		try {
			const result = await this._process.sendRequest<{ items?: StsCompletionItem[] } | StsCompletionItem[] | null>(
				'textDocument/completion',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 }, // Monaco is 1-based, LSP is 0-based
				},
			);

			const items = Array.isArray(result) ? result : (result?.items || []);
			this._output.appendLine(`[sts-diag] getCompletions response boxId=${boxId} rawItems=${items.length} first=${items[0]?.label || '(none)'}`);
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
			this._output.appendLine(`[sts] Completion error: ${err instanceof Error ? err.message : String(err)}`);
			return { items: [] };
		}
	}

	async getHover(boxId: string, line: number, column: number): Promise<StsHoverResult | null> {
		const uri = this._boxIdToUri(boxId);
		await this._waitForConnection(boxId);
		try {
			const result = await this._process.sendRequest<StsHover | null>(
				'textDocument/hover',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 },
				},
			);

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
			this._output.appendLine(`[sts] Hover error: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	async getSignatureHelp(boxId: string, line: number, column: number): Promise<StsSignatureHelpResult | null> {
		const uri = this._boxIdToUri(boxId);
		await this._waitForConnection(boxId);
		try {
			const result = await this._process.sendRequest<StsSignatureHelp | null>(
				'textDocument/signatureHelp',
				{
					textDocument: { uri },
					position: { line: line - 1, character: column - 1 },
				},
			);

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
			this._output.appendLine(`[sts] SignatureHelp error: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── Diagnostics ────────────────────────────────────────────────────

	onDiagnostics(handler: (event: StsDiagnosticsEvent) => void): void {
		this._diagnosticsHandler = handler;
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
