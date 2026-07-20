import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection, type MessageReader, type DataCallback, type Disposable as JrpcDisposable, type Message } from 'vscode-jsonrpc/node';
import type { WorkbenchLogger } from '../workbenchLogger';
import { sanitizeStsLogText } from './stsLogSanitizer';

const MAX_RESTARTS = 2;
const BACKOFF_MS = [1000, 3000]; // 1s, 3s
const INITIALIZE_TIMEOUT_MS = 15000; // 15s for the LSP initialize handshake
const REQUEST_TIMEOUT_MS = 10000; // 10s per IntelliSense request
const STABLE_EPOCH_RESET_MS = 30_000;

export interface StsRequestOptions {
	timeoutMs?: number | null;
	expectedEpoch?: number;
}

export interface StsEpochEvent {
	epoch: number;
	error?: Error;
}

type StsNotificationHandler = (params: any, epoch: number) => void;

export class StsProcessManager {
	private _process: ChildProcess | null = null;
	private _connection: MessageConnection | null = null;
	private _readyResolve?: () => void;
	private _readyReject?: (err: Error) => void;
	private _readyPromise: Promise<void>;
	private _restartCount = 0;
	private _stopped = false;
	private _failed = false;
	private _epoch = 0;
	private _activeEpoch = 0;
	private _lastEndedEpoch = 0;
	private _restartTimer: ReturnType<typeof setTimeout> | undefined;
	private _stableEpochTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _handledProcesses = new WeakSet<ChildProcess>();
	private _binaryPath: string;
	private _logPath: string;
	private readonly _output: WorkbenchLogger;
	private readonly _notificationHandlers = new Map<string, Set<StsNotificationHandler>>();
	private readonly _notificationBindings: JrpcDisposable[] = [];
	private readonly _epochStartHandlers = new Set<(event: StsEpochEvent) => void>();
	private readonly _epochEndHandlers = new Set<(event: StsEpochEvent) => void>();
	private readonly _failedHandlers = new Set<(error: Error) => void>();
	private readonly _epochWaiters = new Map<number, Set<(error: Error) => void>>();

	constructor(binaryPath: string, logPath: string, output: WorkbenchLogger) {
		this._binaryPath = binaryPath;
		this._logPath = logPath;
		this._output = output;
		this._readyPromise = new Promise<void>((resolve, reject) => {
			this._readyResolve = resolve;
			this._readyReject = reject;
		});
		void this._readyPromise.catch(() => { /* callers still observe rejection when awaiting ready */ });
	}

	get ready(): Promise<void> { return this._readyPromise; }
	get isRunning(): boolean { return this._process !== null && this._connection !== null && this._activeEpoch > 0; }
	get isFailed(): boolean { return this._failed; }
	get connection(): MessageConnection | null { return this._connection; }
	get epoch(): number { return this._activeEpoch; }

	async start(): Promise<void> {
		if (this._stopped) return;
		let startedProcess: ChildProcess | null = null;

		try {
			this._output.info(`[sts] Starting STS: ${this._binaryPath}`);

			const proc = spawn(this._binaryPath, [], {
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			startedProcess = proc;

			this._process = proc;

			// Collect early stderr for crash diagnostics.
			let stderrBuf = '';
			proc.stderr?.on('data', (data: Buffer) => {
				const text = sanitizeStsLogText(data.toString().trimEnd());
				stderrBuf += text + '\n';
				this._output.warn(`[sts-stderr] ${text}`);
			});

			// Guard: if the process exits before the handshake finishes, reject
			// immediately instead of waiting for the initialize timeout.
			let earlyExitCode: number | null = null;
			const earlyExitHandler = (code: number | null) => {
				earlyExitCode = code ?? -1;
				this._output.warn(`[sts] Process exited early with code ${code}`);
				if (stderrBuf) {
					this._output.warn(`[sts] Last stderr:\n${stderrBuf.slice(-500)}`);
				}
			};
			proc.once('exit', earlyExitHandler);

			proc.on('error', (err) => {
				this._output.error(`[sts] Process error: ${sanitizeStsLogText(err.message)}`);
				this._handleExit(proc, -1, err);
			});

			// Swallow EPIPE / ECONNRESET on stdin — the process may die before
			// we finish writing the initialize request.
			proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') {
					this._output.warn(`[sts] stdin ${err.code} (process already exited)`);
				} else {
					this._output.error(`[sts] stdin error: ${sanitizeStsLogText(err.message)}`);
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
				this._output.error(`[sts] JSON-RPC error: ${sanitizeStsLogText(err.message)}`);
			});
			connection.onClose(() => {
				this._output.warn('[sts] JSON-RPC connection closed');
				this._handleExit(proc, -1, new Error('STS JSON-RPC connection closed'));
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
				this._output.info(`[sts] Process exited with code ${code}`);
				this._handleExit(proc, code ?? -1, new Error(`STS process exited with code ${code ?? -1}`));
			});

			this._output.info(`[sts] Initialized. Server capabilities: ${Object.keys((initResult as any)?.capabilities || {}).join(', ')}`);

			await connection.sendNotification('initialized', {});

			// Log ALL notifications from STS for diagnostics.
			connection.onNotification((method: string, params: any) => {
				const uri = params?.ownerUri || params?.uri || '';
				this._output.trace(`[sts-diag] NOTIFICATION ${method} uri=${uri} keys=${Object.keys(params || {}).join(',')}`);
			});

			this._markInitialized(connection);
		} catch (err) {
			const msg = sanitizeStsLogText(err instanceof Error ? err.message : err);
			this._output.error(`[sts] Start failed: ${msg}`);
			const exitAlreadyHandled = !!startedProcess && this._handledProcesses.has(startedProcess);
			if (!exitAlreadyHandled) this._rejectReady(msg);
			this._handleExit(startedProcess, -1, err instanceof Error ? err : new Error(msg));
			throw err;
		}
	}

	async stop(): Promise<void> {
		this._stopped = true;
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
			this._restartTimer = undefined;
		}
		if (this._stableEpochTimer) {
			clearTimeout(this._stableEpochTimer);
			this._stableEpochTimer = undefined;
		}
		this._endActiveEpoch(new Error('STS process stopped'));
		this._rejectReady('STS process stopped');
		const connection = this._connection;
		const process = this._process;
		if (connection) {
			try {
				await this._sendWithTimeout(
					connection.sendRequest('shutdown'),
					5000,
					'shutdown',
				);
				await connection.sendNotification('exit');
			} catch { /* process may already be dead */ }
			try { connection.dispose(); } catch { /* ignore */ }
		}
		if (process && process.exitCode === null) {
			const exitedGracefully = await this._waitForProcessExit(process, 2000);
			if (!exitedGracefully) {
				try { process.kill('SIGKILL'); } catch { /* ignore */ }
				await this._waitForProcessExit(process, 2000);
			}
		}
		if (this._connection === connection) this._connection = null;
		if (this._process === process) this._process = null;
		this._disposeNotificationBindings();
	}

	async sendRequest<T>(method: string, params?: unknown, options?: StsRequestOptions): Promise<T> {
		if (this._failed) throw new Error('STS process failed to start');
		await this._readyPromise;
		if (!this._connection) throw new Error('STS connection not available');
		const epoch = this._activeEpoch;
		if (options?.expectedEpoch !== undefined && options.expectedEpoch !== epoch) {
			throw new Error(`STS process epoch changed before ${method}`);
		}
		const request = this._connection.sendRequest(method, params) as Promise<T>;
		const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
		const bounded = timeoutMs === null ? request : this._sendWithTimeout(request, timeoutMs, method);
		return this._raceEpoch(bounded, epoch, method);
	}

	async sendNotification(method: string, params?: unknown): Promise<void> {
		await this._readyPromise;
		if (!this._connection) throw new Error('STS connection not available');
		await this._connection.sendNotification(method, params);
	}

	onNotification(method: string, handler: StsNotificationHandler): vscode.Disposable {
		let handlers = this._notificationHandlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this._notificationHandlers.set(method, handlers);
		}
		handlers.add(handler);
		this._rebindNotificationHandlers();
		return {
			dispose: () => {
				handlers?.delete(handler);
				if (handlers?.size === 0) this._notificationHandlers.delete(method);
				this._rebindNotificationHandlers();
			},
		};
	}

	onDidStartEpoch(handler: (event: StsEpochEvent) => void): vscode.Disposable {
		this._epochStartHandlers.add(handler);
		return { dispose: () => { this._epochStartHandlers.delete(handler); } };
	}

	onDidEndEpoch(handler: (event: StsEpochEvent) => void): vscode.Disposable {
		this._epochEndHandlers.add(handler);
		return { dispose: () => { this._epochEndHandlers.delete(handler); } };
	}

	onDidFail(handler: (error: Error) => void): vscode.Disposable {
		this._failedHandlers.add(handler);
		return { dispose: () => { this._failedHandlers.delete(handler); } };
	}

	private _resolveReady(): void {
		this._readyResolve?.();
		this._readyResolve = undefined;
		this._readyReject = undefined;
	}

	private _markInitialized(connection: MessageConnection): void {
		this._failed = false;
		this._activeEpoch = ++this._epoch;
		if (this._stableEpochTimer) clearTimeout(this._stableEpochTimer);
		this._stableEpochTimer = setTimeout(() => {
			if (this._activeEpoch > 0 && !this._stopped) this._restartCount = 0;
			this._stableEpochTimer = undefined;
		}, STABLE_EPOCH_RESET_MS);
		this._bindNotificationHandlers(connection, this._activeEpoch);
		this._fireEpoch(this._epochStartHandlers, { epoch: this._activeEpoch });
		this._resolveReady();
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

	private _handleExit(process: ChildProcess | null, _code: number, error: Error): void {
		if (process && this._handledProcesses.has(process)) return;
		if (process) this._handledProcesses.add(process);
		if (process && this._process && process !== this._process) return;
		if (this._stableEpochTimer) {
			clearTimeout(this._stableEpochTimer);
			this._stableEpochTimer = undefined;
		}
		this._endActiveEpoch(error);
		this._disposeNotificationBindings();
		const connection = this._connection;
		this._process = null;
		this._connection = null;
		try { connection?.dispose(); } catch { /* ignore */ }
		if (process && process.exitCode === null && !process.killed) {
			try { process.kill(); } catch { /* ignore */ }
		}

		if (this._stopped) return;
		this._rejectReady(error.message || 'STS process stopped');

		if (this._restartCount < MAX_RESTARTS) {
			const delay = BACKOFF_MS[this._restartCount] ?? 3000;
			this._restartCount++;
			this._output.warn(`[sts] Restarting (attempt ${this._restartCount}/${MAX_RESTARTS}) in ${delay}ms...`);

			// Reset the ready promise for the new attempt
			this._readyPromise = new Promise<void>((resolve, reject) => {
				this._readyResolve = resolve;
				this._readyReject = reject;
			});
			void this._readyPromise.catch(() => { /* restart may be stopped before another caller awaits ready */ });

			this._restartTimer = setTimeout(() => {
				this._restartTimer = undefined;
				if (!this._stopped) {
					this.start().catch((err) => {
						this._output.error(`[sts] Restart failed: ${sanitizeStsLogText(err instanceof Error ? err.message : err)}`);
					});
				}
			}, delay);
		} else {
			this._failed = true;
			this._output.error(`[sts] Max restarts (${MAX_RESTARTS}) exhausted. SQL IntelliSense unavailable.`);
			for (const handler of [...this._failedHandlers]) {
				try { handler(new Error('Max restarts exhausted')); } catch { /* isolate failure observers */ }
			}
		}
	}

	private _bindNotificationHandlers(connection: MessageConnection, epoch: number): void {
		this._disposeNotificationBindings();
		for (const [method, handlers] of this._notificationHandlers) {
			this._notificationBindings.push(connection.onNotification(method, (params: any) => {
				for (const handler of [...handlers]) {
					try { handler(params, epoch); } catch (error) {
						this._output.error(`[sts] Notification handler failed (${method}): ${sanitizeStsLogText(error instanceof Error ? error.message : error)}`);
					}
				}
			}));
		}
	}

	private _rebindNotificationHandlers(): void {
		if (this._connection && this._activeEpoch > 0) {
			this._bindNotificationHandlers(this._connection, this._activeEpoch);
		}
	}

	private _disposeNotificationBindings(): void {
		for (const binding of this._notificationBindings.splice(0)) {
			try { binding.dispose(); } catch { /* ignore */ }
		}
	}

	private _endActiveEpoch(error: Error): void {
		const epoch = this._activeEpoch;
		if (!epoch || this._lastEndedEpoch === epoch) return;
		this._lastEndedEpoch = epoch;
		this._activeEpoch = 0;
		const waiters = this._epochWaiters.get(epoch);
		this._epochWaiters.delete(epoch);
		for (const reject of waiters ?? []) reject(error);
		this._fireEpoch(this._epochEndHandlers, { epoch, error });
	}

	private _raceEpoch<T>(promise: Promise<T>, epoch: number, method: string): Promise<T> {
		if (!epoch || this._activeEpoch !== epoch) {
			return Promise.reject(new Error(`STS process epoch changed during ${method}`));
		}
		let rejectEpoch: (error: Error) => void = () => undefined;
		const epochEnded = new Promise<never>((_resolve, reject) => { rejectEpoch = reject; });
		let waiters = this._epochWaiters.get(epoch);
		if (!waiters) {
			waiters = new Set();
			this._epochWaiters.set(epoch, waiters);
		}
		waiters.add(rejectEpoch);
		return Promise.race([promise, epochEnded]).finally(() => {
			waiters?.delete(rejectEpoch);
			if (waiters?.size === 0) this._epochWaiters.delete(epoch);
		});
	}

	private _fireEpoch(handlers: Set<(event: StsEpochEvent) => void>, event: StsEpochEvent): void {
		for (const handler of [...handlers]) {
			try { handler(event); } catch { /* isolate lifecycle observers */ }
		}
	}

	private _waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (process.exitCode !== null) return Promise.resolve(true);
		return new Promise(resolve => {
			let settled = false;
			const finish = (exited: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				process.removeListener('exit', onExit);
				resolve(exited);
			};
			const onExit = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);
			process.once('exit', onExit);
		});
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
