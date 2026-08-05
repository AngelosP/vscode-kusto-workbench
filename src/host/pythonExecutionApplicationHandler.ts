import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';

import type { IncomingWebviewMessage } from './queryEditorTypes';

const PYTHON_EXECUTION_TIMEOUT_MS = 15_000;
const PYTHON_OUTPUT_MAX_BYTES = 200 * 1024;

type ExecutePythonMessage = Extract<IncomingWebviewMessage, { type: 'executePython' }>;

type ActivePythonAttempt = {
	cancel(): void;
};

type BoundedPythonOutput = {
	chunks: Buffer[];
	byteLength: number;
};

class PythonExecutionDisposedError extends Error {}

function appendOutput(output: BoundedPythonOutput, chunk: Buffer): void {
	const remaining = PYTHON_OUTPUT_MAX_BYTES - output.byteLength;
	if (remaining <= 0) return;
	const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
	output.chunks.push(Buffer.from(accepted));
	output.byteLength += accepted.byteLength;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	const encoded = Buffer.from(text, 'utf8');
	if (encoded.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
	return encoded.subarray(0, end).toString('utf8');
}

function renderOutput(output: BoundedPythonOutput, suffix?: string): string {
	const decoder = new StringDecoder('utf8');
	const decoded = decoder.write(Buffer.concat(output.chunks, output.byteLength));
	if (!suffix) return truncateUtf8(decoded, PYTHON_OUTPUT_MAX_BYTES);
	const suffixBytes = Buffer.byteLength(suffix, 'utf8');
	const prefix = truncateUtf8(decoded, Math.max(0, PYTHON_OUTPUT_MAX_BYTES - suffixBytes - 1));
	return `${prefix}${prefix ? '\n' : ''}${suffix}`;
}

function isExpectedStdioTeardownError(error: unknown): boolean {
	if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false;
	const code = String((error as { code?: unknown }).code || '');
	return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}

export interface PythonExecutionApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type PythonProcessFactory = (
	command: string,
	args: string[],
	cwd: string | undefined,
) => ChildProcessWithoutNullStreams;

export type PythonExecutionApplicationHandlerOptions = {
	postMessage: (message: unknown) => Thenable<boolean>;
	createProcess?: PythonProcessFactory;
	getWorkingDirectory?: () => string | undefined;
};

export class HostPythonExecutionApplicationHandler implements PythonExecutionApplicationHandler {
	private readonly activeAttempts = new Set<ActivePythonAttempt>();
	private readonly createProcess: PythonProcessFactory;
	private readonly getWorkingDirectory: () => string | undefined;
	private disposed = false;

	constructor(private readonly options: PythonExecutionApplicationHandlerOptions) {
		this.createProcess = options.createProcess ?? ((command, args, cwd) => spawn(command, args, {
			cwd,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		}));
		this.getWorkingDirectory = options.getWorkingDirectory
			?? (() => vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath);
	}

	private postMessage(message: unknown): Thenable<boolean> {
		return this.options.postMessage(message);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'executePython') return undefined;
		return this.executePython(message);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const attempt of [...this.activeAttempts]) attempt.cancel();
		this.activeAttempts.clear();
	}

	private async executePython(message: ExecutePythonMessage): Promise<void> {
		const boxId = String(message.boxId || '').trim();
		const code = String(message.code || '');
		if (!boxId || this.disposed) return;

		const cwd = this.getWorkingDirectory();
		const candidates: Array<{ command: string; args: string[] }> = [
			{ command: 'python', args: ['-'] },
			{ command: 'python3', args: ['-'] },
			{ command: 'py', args: ['-'] },
		];

		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				const result = await this.runOnce(candidate.command, candidate.args, cwd, code);
				if (!this.disposed) {
					void this.postMessage({ type: 'pythonResult', boxId, ...result });
				}
				return;
			} catch (error: unknown) {
				if (error instanceof PythonExecutionDisposedError || this.disposed) return;
				lastError = error;
				if (this.isCommandNotFound(error)) continue;
				break;
			}
		}

		if (this.disposed) return;
		const error = this.getErrorMessage(lastError) ?? 'Python execution failed (python not found?).';
		void this.postMessage({ type: 'pythonError', boxId, error });
	}

	private runOnce(
		command: string,
		args: string[],
		cwd: string | undefined,
		code: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
		return new Promise((resolve, reject) => {
			const stdout: BoundedPythonOutput = { chunks: [], byteLength: 0 };
			const stderr: BoundedPythonOutput = { chunks: [], byteLength: 0 };
			let done = false;
			const child = this.createProcess(command, args, cwd);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.activeAttempts.delete(attempt);
			};
			const settle = (result: { stdout: string; stderr: string; exitCode: number | null }) => {
				if (done) return;
				done = true;
				cleanup();
				resolve(result);
			};
			const fail = (error: unknown) => {
				if (done) return;
				done = true;
				cleanup();
				reject(error);
			};
			const attempt: ActivePythonAttempt = {
				cancel: () => {
					if (done) return;
					done = true;
					cleanup();
					try { child.kill(); } catch { /* ignore */ }
					reject(new PythonExecutionDisposedError('Python execution handler disposed.'));
				},
			};
			this.activeAttempts.add(attempt);

			timer = setTimeout(() => {
				if (done) return;
				done = true;
				cleanup();
				try { child.kill(); } catch { /* ignore */ }
				resolve({
					stdout: renderOutput(stdout),
					stderr: renderOutput(stderr, 'Timed out after 15s.'),
					exitCode: -1,
				});
			}, PYTHON_EXECUTION_TIMEOUT_MS);

			child.stdout.on('data', (data: Buffer) => {
				appendOutput(stdout, data);
			});
			child.stderr.on('data', (data: Buffer) => {
				appendOutput(stderr, data);
			});
			const handleStdioError = (error: unknown) => {
				if (done || isExpectedStdioTeardownError(error)) return;
				fail(error);
				try { child.kill(); } catch { /* ignore */ }
			};
			child.stdin.on('error', handleStdioError);
			child.stdout.on('error', handleStdioError);
			child.stderr.on('error', handleStdioError);
			child.on('error', fail);
			child.on('close', exitCode => {
				settle({
					stdout: renderOutput(stdout),
					stderr: renderOutput(stderr),
					exitCode: typeof exitCode === 'number' ? exitCode : -1,
				});
			});

			try {
				child.stdin.write(code);
				child.stdin.end();
			} catch {
				// Ignore stdin errors; the process terminal remains authoritative.
			}
		});
	}

	private isCommandNotFound(error: unknown): boolean {
		if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false;
		const candidate = error as { code?: unknown };
		return String(candidate.code || '') === 'ENOENT'
			|| (this.getErrorMessage(error)?.includes('ENOENT') ?? false);
	}

	private getErrorMessage(error: unknown): string | undefined {
		if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
		const candidate = error as { message?: unknown };
		return typeof candidate.message === 'string' ? candidate.message : undefined;
	}
}