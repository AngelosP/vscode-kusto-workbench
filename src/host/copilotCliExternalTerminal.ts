import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
	CopilotCliConnectionCancelledError,
	type CopilotCliTerminal,
} from './copilotCliSessionManager';

const RECEIPT_PREFIX = 'KUSTO_WORKBENCH_EXTERNAL_CLI:';
const MAX_RECEIPT_BYTES = 8 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const STOP_MARKER_GRACE_MS = 1_000;

export const EXTERNAL_CLI_RUNNER_SCRIPT = String.raw`param(
    [Parameter(Mandatory = $true)]
    [string]$DescriptorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$descriptor = Get-Content -LiteralPath $DescriptorPath -Raw -Encoding UTF8 | ConvertFrom-Json

while ($true) {
    if (Test-Path -LiteralPath ([string]$descriptor.stopPath)) {
        exit 1
    }
    if (Test-Path -LiteralPath ([string]$descriptor.startPath)) {
        break
    }
    [System.Threading.Thread]::Sleep(50)
}

Set-Location -LiteralPath ([string]$descriptor.workingDirectory)
try {
    $Host.UI.RawUI.WindowTitle = [string]$descriptor.title
} catch {
    # Some console hosts do not expose a writable title.
}

$cliExecutable = [string]$descriptor.cliExecutable
$cliArguments = @($descriptor.arguments | ForEach-Object { [string]$_ })
& $cliExecutable @cliArguments
if ($null -eq $LASTEXITCODE) {
    exit 1
}
exit [int]$LASTEXITCODE
`;

export const EXTERNAL_CLI_BROKER_SCRIPT = String.raw`param(
    [Parameter(Mandatory = $true)]
    [string]$DescriptorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class KustoWorkbenchKillOnCloseJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateAndAssignCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the external CLI job object.");

        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure the external CLI job object.");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign the external CLI broker to its job object.");

            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }
}
'@

$jobHandle = [IntPtr]::Zero
$terminal = $null
try {
    $descriptor = Get-Content -LiteralPath $DescriptorPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $jobHandle = [KustoWorkbenchKillOnCloseJob]::CreateAndAssignCurrentProcess()
    $startOptions = @{
        FilePath = [string]$descriptor.powerShellExecutable
        ArgumentList = @(
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            [string]$descriptor.encodedRunnerCommand
        )
        WorkingDirectory = [string]$descriptor.workingDirectory
        PassThru = $true
    }
    $terminal = Start-Process @startOptions
    [System.IO.File]::WriteAllText([string]$descriptor.visiblePidPath, [string]$terminal.Id, [System.Text.UTF8Encoding]::new($false))
    $receipt = @{ protocol = 1; visibleProcessId = $terminal.Id } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine('${RECEIPT_PREFIX}' + $receipt)
    [Console]::Out.Flush()

    $stopRequested = $false
    while (-not $terminal.WaitForExit(100)) {
        if (-not $stopRequested -and (Test-Path -LiteralPath ([string]$descriptor.stopPath))) {
            $stopRequested = $true
            & ([string]$descriptor.taskkillExecutable) /PID ([string]$terminal.Id) /T /F | Out-Null
        }
    }
    $exitCode = [int]$terminal.ExitCode
    [System.IO.File]::WriteAllText([string]$descriptor.exitedPath, '1' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    exit $exitCode
} catch {
    if ($null -ne $terminal) {
        try {
            if (-not $terminal.HasExited) {
                & ([string]$descriptor.taskkillExecutable) /PID ([string]$terminal.Id) /T /F | Out-Null
                $terminal.WaitForExit()
            }
        } catch {
            # Closing the broker process also closes its kill-on-close job handle.
        }
    }
    [Console]::Error.WriteLine('External Copilot CLI launcher failed: ' + $_.Exception.Message)
    exit 1
}
`;

export interface ExternalCliLaunchDescriptorOptions {
	readonly cliExecutable: string;
	readonly arguments: readonly string[];
	readonly workingDirectory: string;
	readonly powerShellExecutable: string;
	readonly taskkillExecutable: string;
	readonly runnerScriptPath: string;
	readonly descriptorPath: string;
	readonly startPath: string;
	readonly stopPath: string;
	readonly exitedPath: string;
	readonly visiblePidPath: string;
}

export function createExternalCliLaunchDescriptor(options: ExternalCliLaunchDescriptorOptions): string {
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const runnerCommand = `& ${literal(options.runnerScriptPath)} -DescriptorPath ${literal(options.descriptorPath)}`;
	return `${JSON.stringify({
		protocol: 1,
		title: 'Kusto Workbench Copilot CLI',
		cliExecutable: options.cliExecutable,
		arguments: [...options.arguments],
		workingDirectory: options.workingDirectory,
		powerShellExecutable: options.powerShellExecutable,
		taskkillExecutable: options.taskkillExecutable,
		startPath: options.startPath,
		stopPath: options.stopPath,
		exitedPath: options.exitedPath,
		visiblePidPath: options.visiblePidPath,
		encodedRunnerCommand: Buffer.from(runnerCommand, 'utf16le').toString('base64'),
	}, null, 2)}\n`;
}

type SpawnBroker = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface LaunchExternalCopilotCliTerminalOptions {
	readonly powerShellExecutable: string;
	readonly taskkillExecutable: string;
	readonly brokerScriptPath: string;
	readonly descriptorPath: string;
	readonly startPath: string;
	readonly stopPath: string;
	readonly workingDirectory: string;
	readonly signal: AbortSignal;
	readonly onClosed: (terminalId: string) => void | Promise<void>;
	readonly onError?: (message: string) => void;
	readonly spawnBroker?: SpawnBroker;
	readonly writeMarker?: (path: string) => Promise<void>;
	readonly terminateBrokerTree?: (process: ChildProcess, taskkillExecutable: string) => Promise<boolean>;
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
}

function isAlreadyExistsError(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

async function writeExclusiveMarker(path: string): Promise<void> {
	try {
		await writeFile(path, '1\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	} catch (error) {
		if (!isAlreadyExistsError(error)) throw error;
	}
}

function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		void promise.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

function terminateProcessTree(process: ChildProcess, taskkillExecutable: string): Promise<boolean> {
	if (process.exitCode !== null || process.pid === undefined) return Promise.resolve(false);
	return new Promise<boolean>((resolve, reject) => {
		execFile(taskkillExecutable, ['/PID', String(process.pid), '/T', '/F'], {
			windowsHide: true,
			timeout: DEFAULT_SHUTDOWN_TIMEOUT_MS,
		}, error => {
			if (!error) resolve(true);
			else if (process.exitCode !== null || (typeof error.code === 'number' && error.code === 128)) resolve(false);
			else reject(new Error('Could not stop the external Copilot CLI process tree.'));
		});
	});
}

class ExternalCopilotCliTerminal implements CopilotCliTerminal {
	readonly id = randomUUID();
	private readonly brokerClosed: Promise<void>;
	private resolveBrokerClosed!: () => void;
	private brokerHasClosed = false;
	private closed = false;
	private presented = false;
	private cleanupTail: Promise<void> = Promise.resolve();
	private showPromise: Promise<void> | undefined;

	constructor(
		private readonly process: ChildProcess,
		private readonly startup: Promise<number>,
		private readonly startPath: string,
		private readonly stopPath: string,
		private readonly taskkillExecutable: string,
		private readonly signal: AbortSignal,
		private readonly writeMarker: (path: string) => Promise<void>,
		private readonly terminateBrokerTree: (process: ChildProcess, taskkillExecutable: string) => Promise<boolean>,
		private readonly shutdownTimeoutMs: number,
		private readonly onClosed: (terminalId: string) => void | Promise<void>,
		private readonly onError: (message: string) => void,
	) {
		this.brokerClosed = new Promise<void>(resolve => { this.resolveBrokerClosed = resolve; });
		this.process.once('close', () => {
			this.brokerHasClosed = true;
			this.resolveBrokerClosed();
			if (this.presented) this.scheduleNaturalClose();
		});
		this.process.once('error', error => {
			this.onError(`External Copilot CLI launcher failed: ${error.message}`);
		});
	}

	isClosed(): boolean {
		return this.closed || this.brokerHasClosed || this.process.exitCode !== null;
	}

	show(): Promise<void> {
		if (!this.showPromise) {
			this.showPromise = (async () => {
				if (this.signal.aborted) throw new CopilotCliConnectionCancelledError();
				await this.startup;
				if (this.signal.aborted || this.brokerHasClosed || this.process.exitCode !== null) throw new CopilotCliConnectionCancelledError();
				await this.writeMarker(this.startPath);
				if (this.signal.aborted || this.brokerHasClosed || this.process.exitCode !== null) throw new CopilotCliConnectionCancelledError();
				this.presented = true;
			})();
		}
		return this.showPromise;
	}

	dispose(): Promise<void> {
		return this.enqueueCleanup(() => this.stop());
	}

	private enqueueCleanup(operation: () => Promise<void>): Promise<void> {
		const run = this.cleanupTail.then(operation, operation);
		this.cleanupTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private scheduleNaturalClose(): void {
		void this.enqueueCleanup(async () => this.markClosed()).catch(error => {
			this.onError(`External Copilot CLI cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.presented) return;
		try {
			const result = this.onClosed(this.id);
			void Promise.resolve(result).catch(error => {
				this.onError(`External Copilot CLI cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		} catch (error) {
			this.onError(`External Copilot CLI cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async stop(): Promise<void> {
		if (this.closed) return;
		try {
			await this.writeMarker(this.stopPath);
		} catch {
			// Broker-tree termination remains authoritative if the marker cannot be written.
		}
		if (await waitForPromise(this.brokerClosed, Math.min(STOP_MARKER_GRACE_MS, this.shutdownTimeoutMs))) {
			this.markClosed();
			return;
		}
		const terminationStarted = await this.terminateBrokerTree(this.process, this.taskkillExecutable);
		if (!terminationStarted && !await waitForPromise(this.brokerClosed, this.shutdownTimeoutMs)) {
			throw new Error('External Copilot CLI broker identity was lost before process-tree cleanup.');
		}
		if (terminationStarted && !await waitForPromise(this.brokerClosed, this.shutdownTimeoutMs)) {
			throw new Error('External Copilot CLI process tree did not stop.');
		}
		this.markClosed();
	}
}

function waitForBrokerReceipt(
	process: ChildProcess,
	signal: AbortSignal,
	timeoutMs: number,
	stderrText: () => string,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		let stdout = '';
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			process.stdout?.removeListener('data', onData);
			process.removeListener('error', onError);
			process.removeListener('close', onClose);
		};
		const settle = (processId?: number, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			process.stdout?.resume();
			if (error) reject(error);
			else resolve(processId!);
		};
		const onAbort = () => settle(undefined, new CopilotCliConnectionCancelledError());
		const onError = (error: Error) => settle(undefined, error);
		const onClose = () => {
			const detail = stderrText().trim();
			settle(undefined, new Error(detail || 'External Copilot CLI launcher exited before creating a console.'));
		};
		const onData = (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (Buffer.byteLength(stdout, 'utf8') > MAX_RECEIPT_BYTES) {
				settle(undefined, new Error('External Copilot CLI launcher returned an invalid startup receipt.'));
				return;
			}
			let newlineIndex: number;
			while ((newlineIndex = stdout.indexOf('\n')) >= 0) {
				const line = stdout.slice(0, newlineIndex).replace(/\r$/, '');
				stdout = stdout.slice(newlineIndex + 1);
				if (!line.startsWith(RECEIPT_PREFIX)) continue;
				try {
					const receipt = JSON.parse(line.slice(RECEIPT_PREFIX.length)) as {
						protocol?: unknown;
						visibleProcessId?: unknown;
					};
					if (receipt.protocol !== 1
						|| !Number.isSafeInteger(receipt.visibleProcessId)
						|| (receipt.visibleProcessId as number) <= 0) {
						throw new Error('invalid receipt');
					}
					settle(receipt.visibleProcessId as number);
				} catch {
					settle(undefined, new Error('External Copilot CLI launcher returned an invalid startup receipt.'));
				}
				return;
			}
		};
		const timer = setTimeout(() => {
			settle(undefined, new Error('External Copilot CLI console did not start within 15 seconds.'));
		}, timeoutMs);
		if (!process.stdout) {
			settle(undefined, new Error('External Copilot CLI launcher has no startup channel.'));
			return;
		}
		process.stdout.on('data', onData);
		process.once('error', onError);
		process.once('close', onClose);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

export async function launchExternalCopilotCliTerminal(
	options: LaunchExternalCopilotCliTerminalOptions,
): Promise<CopilotCliTerminal> {
	if (options.signal.aborted) throw new CopilotCliConnectionCancelledError();
	const spawnBroker = options.spawnBroker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
	const writeMarker = options.writeMarker ?? writeExclusiveMarker;
	const terminateBroker = options.terminateBrokerTree ?? terminateProcessTree;
	const process = spawnBroker(options.powerShellExecutable, [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		options.brokerScriptPath,
		'-DescriptorPath',
		options.descriptorPath,
	], {
		cwd: options.workingDirectory,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	process.stderr?.on('data', chunk => {
		if (stderr.length < MAX_RECEIPT_BYTES) stderr += chunk.toString();
	});
	const startup = waitForBrokerReceipt(
		process,
		options.signal,
		options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
		() => stderr,
	);
	void startup.catch(() => undefined);
	return new ExternalCopilotCliTerminal(
		process,
		startup,
		options.startPath,
		options.stopPath,
		options.taskkillExecutable,
		options.signal,
		writeMarker,
		terminateBroker,
		options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
		options.onClosed,
		options.onError ?? (() => {}),
	);
}