import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection, type MessageReader, type DataCallback, type Disposable as JrpcDisposable, type Message } from 'vscode-jsonrpc/node';

const MAX_RESTARTS = 2;
const BACKOFF_MS = [1000, 3000]; // 1s, 3s
const INITIALIZE_TIMEOUT_MS = 15000; // 15s for the LSP initialize handshake
const REQUEST_TIMEOUT_MS = 10000; // 10s per IntelliSense request

export class StsProcessManager {
	private _process: ChildProcess | null = null;
	private _connection: MessageConnection | null = null;
	private _readyResolve?: () => void;
	private _readyReject?: (err: Error) => void;
	private _readyPromise: Promise<void>;
	private _restartCount = 0;
	private _stopped = false;
	private _failed = false;
	private _binaryPath: string;
	private _logPath: string;
	private readonly _output: vscode.OutputChannel;

	constructor(binaryPath: string, logPath: string, output: vscode.OutputChannel) {
		this._binaryPath = binaryPath;
		this._logPath = logPath;
		this._output = output;
		this._readyPromise = new Promise<void>((resolve, reject) => {
			this._readyResolve = resolve;
			this._readyReject = reject;
		});
	}

	get ready(): Promise<void> { return this._readyPromise; }
	get isRunning(): boolean { return this._process !== null && this._connection !== null; }
	get isFailed(): boolean { return this._failed; }
	get connection(): MessageConnection | null { return this._connection; }

	async start(): Promise<void> {
		if (this._stopped) return;

		try {
			this._output.appendLine(`[sts] Starting STS: ${this._binaryPath}`);

			const proc = spawn(this._binaryPath, [], {
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			this._process = proc;

			// Collect early stderr for crash diagnostics.
			let stderrBuf = '';
			proc.stderr?.on('data', (data: Buffer) => {
				const text = data.toString().trimEnd();
				stderrBuf += text + '\n';
				this._output.appendLine(`[sts-stderr] ${text}`);
			});

			// Guard: if the process exits before the handshake finishes, reject
			// immediately instead of waiting for the initialize timeout.
			let earlyExitCode: number | null = null;
			const earlyExitHandler = (code: number | null) => {
				earlyExitCode = code ?? -1;
				this._output.appendLine(`[sts] Process exited early with code ${code}`);
				if (stderrBuf) {
					this._output.appendLine(`[sts] Last stderr:\n${stderrBuf.slice(-500)}`);
				}
			};
			proc.once('exit', earlyExitHandler);

			proc.on('error', (err) => {
				this._output.appendLine(`[sts] Process error: ${err.message}`);
				this._handleExit(-1);
			});

			// Swallow EPIPE / ECONNRESET on stdin — the process may die before
			// we finish writing the initialize request.
			proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') {
					this._output.appendLine(`[sts] stdin ${err.code} (process already exited)`);
				} else {
					this._output.appendLine(`[sts] stdin error: ${err.message}`);
				}
			});

			// Create JSON-RPC connection.
			// STS converts numeric request IDs to strings in responses
			// (e.g. we send id:1, STS responds with id:"1"). vscode-jsonrpc
			// uses a Map keyed by number, so "1" !== 1 and responses are
			// never matched. The normalizing wrapper fixes this.
			const rawReader = new StreamMessageReader(proc.stdout!);
			const reader = createIdNormalizingReader(rawReader);
			const writer = new StreamMessageWriter(proc.stdin!);
			const connection = createMessageConnection(reader, writer);
			this._connection = connection;

			// Catch JSON-RPC transport errors (EPIPE, broken pipe, etc.)
			connection.onError(([err]) => {
				this._output.appendLine(`[sts] JSON-RPC error: ${err.message}`);
			});
			connection.onClose(() => {
				this._output.appendLine('[sts] JSON-RPC connection closed');
			});

			connection.listen();

			// If the process already exited, bail out now.
			if (earlyExitCode !== null) {
				throw new Error(`STS process exited with code ${earlyExitCode} before initialize`);
			}

			// LSP initialize handshake — with timeout to avoid hanging forever
			const initResult = await this._sendWithTimeout<any>(
				connection.sendRequest('initialize', {
					processId: process.pid,
					capabilities: {
						textDocument: {
							completion: {
								completionItem: { snippetSupport: false },
							},
							hover: { contentFormat: ['plaintext', 'markdown'] },
							signatureHelp: { signatureInformation: { documentationFormat: ['plaintext', 'markdown'] } },
							publishDiagnostics: { relatedInformation: false },
						},
					},
					rootUri: null,
				}),
				INITIALIZE_TIMEOUT_MS,
				'initialize handshake',
			);

			// Remove the early-exit guard — replace with the long-running handler
			proc.removeListener('exit', earlyExitHandler);
			proc.on('exit', (code) => {
				this._output.appendLine(`[sts] Process exited with code ${code}`);
				this._handleExit(code ?? -1);
			});

			this._output.appendLine(`[sts] Initialized. Server capabilities: ${Object.keys((initResult as any)?.capabilities || {}).join(', ')}`);

			connection.sendNotification('initialized', {});

			// Log ALL notifications from STS for diagnostics.
			connection.onNotification((method: string, params: any) => {
				const uri = params?.ownerUri || params?.uri || '';
				this._output.appendLine(`[sts-diag] NOTIFICATION ${method} uri=${uri} keys=${Object.keys(params || {}).join(',')}`);
			});

			this._restartCount = 0;
			this._failed = false;
			this._readyResolve?.();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._output.appendLine(`[sts] Start failed: ${msg}`);
			this._rejectReady(msg);
			this._handleExit(-1);
		}
	}

	async stop(): Promise<void> {
		this._stopped = true;
		if (this._connection) {
			try {
				await this._sendWithTimeout(
					this._connection.sendRequest('shutdown'),
					5000,
					'shutdown',
				);
				this._connection.sendNotification('exit');
			} catch { /* process may already be dead */ }
			try { this._connection.dispose(); } catch { /* ignore */ }
			this._connection = null;
		}
		if (this._process) {
			try { this._process.kill(); } catch { /* ignore */ }
			this._process = null;
		}
	}

	async sendRequest<T>(method: string, params?: unknown): Promise<T> {
		if (this._failed) throw new Error('STS process failed to start');
		await this._readyPromise;
		if (!this._connection) throw new Error('STS connection not available');
		return this._sendWithTimeout<T>(
			this._connection.sendRequest(method, params) as Promise<T>,
			REQUEST_TIMEOUT_MS,
			method,
		);
	}

	sendNotification(method: string, params?: unknown): void {
		if (!this._connection) return;
		this._connection.sendNotification(method, params);
	}

	onNotification(method: string, handler: (params: any) => void): void {
		// We need to wait for connection to be ready, but notifications
		// can be registered before the handshake completes.
		const register = () => {
			if (this._connection) {
				this._connection.onNotification(method, handler);
			}
		};

		if (this._connection) {
			register();
		} else {
			// Register after connection is established
			this._readyPromise.then(register).catch(() => { /* ignore — process failed */ });
		}
	}

	/** Reject the ready promise if it hasn't been settled yet. */
	private _rejectReady(reason: string): void {
		if (this._readyReject) {
			this._readyReject(new Error(reason));
			this._readyResolve = undefined;
			this._readyReject = undefined;
		}
	}

	/** Wrap a promise with a timeout. */
	private _sendWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`STS ${label} timed out after ${ms}ms`));
			}, ms);

			promise.then(
				(result) => { clearTimeout(timer); resolve(result); },
				(err) => { clearTimeout(timer); reject(err); },
			);
		});
	}

	private _handleExit(code: number): void {
		this._process = null;
		this._connection = null;

		if (this._stopped || code === 0) return;

		if (this._restartCount < MAX_RESTARTS) {
			const delay = BACKOFF_MS[this._restartCount] ?? 3000;
			this._restartCount++;
			this._output.appendLine(`[sts] Restarting (attempt ${this._restartCount}/${MAX_RESTARTS}) in ${delay}ms...`);

			// Reset the ready promise for the new attempt
			this._readyPromise = new Promise<void>((resolve, reject) => {
				this._readyResolve = resolve;
				this._readyReject = reject;
			});

			setTimeout(() => {
				if (!this._stopped) {
					this.start().catch((err) => {
						this._output.appendLine(`[sts] Restart failed: ${err instanceof Error ? err.message : String(err)}`);
					});
				}
			}, delay);
		} else {
			this._failed = true;
			this._output.appendLine(`[sts] Max restarts (${MAX_RESTARTS}) exhausted. SQL IntelliSense unavailable.`);
			this._rejectReady('Max restarts exhausted');
		}
	}
}

// ── ID-normalizing reader wrapper ──────────────────────────────────────────
// STS (SqlToolsService) converts numeric JSON-RPC request IDs to strings in
// its responses. vscode-jsonrpc stores pending request promises in a Map keyed
// by number, so Map.get("1") never finds the entry stored under key 1.
// This wrapper intercepts parsed messages and converts string IDs that look
// like integers back to numbers before vscode-jsonrpc tries to match them.

function createIdNormalizingReader(inner: MessageReader): MessageReader {
	return {
		onError: inner.onError,
		onClose: inner.onClose,
		onPartialMessage: inner.onPartialMessage,
		listen(callback: DataCallback): JrpcDisposable {
			return inner.listen((msg: Message) => {
				const m = msg as any;
				if (m && m.id !== undefined && typeof m.id === 'string') {
					const n = Number(m.id);
					if (Number.isFinite(n)) {
						m.id = n;
					}
				}
				callback(msg);
			});
		},
		dispose(): void { inner.dispose(); },
	};
}

// ── Module-level singleton ─────────────────────────────────────────────────
// Shared across all QueryEditorProvider instances. Set once on first SQL use,
// read by extension.ts deactivate() for graceful shutdown.

let _singleton: StsProcessManager | null = null;

export const stsProcessManagerSingleton = {
	get(): StsProcessManager | null { return _singleton; },
	set(pm: StsProcessManager): void { _singleton = pm; },
};
