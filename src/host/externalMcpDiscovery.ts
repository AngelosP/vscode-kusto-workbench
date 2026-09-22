import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkbenchProviderDescriptor } from '../connector/externalMcpConnectorCore';

const READY_LINE = 'KUSTO_WORKBENCH_DISCOVERY_READY';
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;

export const EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT = String.raw`Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

public static class KustoWorkbenchDiscoveryPipe
{
    public static NamedPipeServerStream Create(string name)
    {
		SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
		PipeSecurity security = new PipeSecurity();
		security.SetOwner(user);
		security.SetAccessRuleProtection(true, false);
		security.AddAccessRule(new PipeAccessRule(
			user,
			PipeAccessRights.FullControl,
			AccessControlType.Allow));
        return new NamedPipeServerStream(
            name,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
			PipeOptions.Asynchronous,
			4096,
			4096,
			security);
    }
}
'@

$descriptor = [Console]::In.ReadLine() | ConvertFrom-Json
$ready = $false
$parentProcessId = [int]$descriptor.parentProcessId
$announcementPath = [string]$descriptor.announcementPath

function Test-ParentAlive {
	return $null -ne (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue)
}

try {
	:serverLoop while (Test-ParentAlive) {
		$pipe = [KustoWorkbenchDiscoveryPipe]::Create([string]$descriptor.pipeName)
		try {
			if (-not $ready) {
				$ready = $true
				[Console]::Out.WriteLine('${READY_LINE}')
				[Console]::Out.Flush()
			}
			$wait = $pipe.BeginWaitForConnection($null, $null)
			try {
				while (-not $wait.AsyncWaitHandle.WaitOne(500)) {
					if (-not (Test-ParentAlive)) { break serverLoop }
				}
				$pipe.EndWaitForConnection($wait)
			} finally {
				$wait.AsyncWaitHandle.Dispose()
			}
			$reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
			$writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
			$writer.AutoFlush = $true
			try {
				$request = $reader.ReadLine()
				if ($request -eq '{"protocolVersion":1,"type":"discover"}') {
					$writer.WriteLine([string]$descriptor.response)
				}
			} finally {
				$writer.Dispose()
				$reader.Dispose()
			}
		} finally {
			$pipe.Dispose()
		}
	}
} finally {
	Remove-Item -LiteralPath $announcementPath -Force -ErrorAction SilentlyContinue
}
`;

export interface ExternalMcpDiscoveryLogger {
	error(message: string): void;
	warn(message: string): void;
}

export interface ExternalMcpDiscoveryServer {
	readonly announcementPath: string;
	readonly pipeName: string;
	close(): Promise<void>;
}

function execFileText(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile(command, [...args], { windowsHide: true, timeout: 10_000, env }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

export async function ensureCurrentUserOnlyDirectory(
	directory: string,
	systemRoot = process.env.SystemRoot,
): Promise<void> {
	if (process.platform !== 'win32') throw new Error('External MCP discovery currently supports Windows only.');
	if (!systemRoot) throw new Error('The Windows system directory is unavailable.');
	await mkdir(directory, { recursive: true });
	const powerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const script = String.raw`
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
	$identity,
	[System.Security.AccessControl.FileSystemRights]::FullControl,
	[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
	[System.Security.AccessControl.PropagationFlags]::None,
	[System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$directory = [System.IO.DirectoryInfo]::new($env:KUSTO_WORKBENCH_SECURE_DIRECTORY)
$directory.SetAccessControl($acl)
$verified = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$rules = @($verified.Access)
if (-not $verified.AreAccessRulesProtected -or $rules.Count -ne 1 -or
	$rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or
	$rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
	($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
	throw 'Failed to apply an exact current-user-only directory ACL.'
}
`;
	await execFileText(powerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
	], { ...process.env, KUSTO_WORKBENCH_SECURE_DIRECTORY: directory });
}

function waitForReady(process: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			process.stdout?.removeListener('data', onStdout);
			process.stderr?.removeListener('data', onStderr);
			process.removeListener('error', onError);
			process.removeListener('close', onClose);
		};
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			process.stdout?.resume();
			process.stderr?.resume();
			if (error) reject(error);
			else resolve();
		};
		const onStdout = (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (stdout.includes(`${READY_LINE}\n`) || stdout.includes(`${READY_LINE}\r\n`)) settle();
			else if (Buffer.byteLength(stdout, 'utf8') > MAX_HELPER_OUTPUT_BYTES) settle(new Error('Discovery helper emitted excessive output.'));
		};
		const onStderr = (chunk: Buffer | string) => {
			if (stderr.length < MAX_HELPER_OUTPUT_BYTES) stderr += chunk.toString();
		};
		const onError = (error: Error) => settle(error);
		const onClose = () => settle(new Error(stderr.trim() || 'Discovery helper exited before readiness.'));
		const timer = setTimeout(() => settle(new Error('Discovery helper did not become ready within 10 seconds.')), timeoutMs);
		process.stdout?.on('data', onStdout);
		process.stderr?.on('data', onStderr);
		process.once('error', onError);
		process.once('close', onClose);
	});
}

function waitForProcessClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise(resolve => {
		let settled = false;
		const settle = (closed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off('close', onClose);
			resolve(closed);
		};
		const onClose = () => settle(true);
		const timer = setTimeout(() => settle(false), timeoutMs);
		child.once('close', onClose);
	});
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill();
	if (await waitForProcessClose(child, 2_000)) return;
	if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
		try {
			await execFileText(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), [
				'/pid', String(child.pid), '/T', '/F',
			]);
		} catch {
			if (child.exitCode === null && child.signalCode === null) {
				throw new Error('Discovery helper process tree could not be stopped.');
			}
		}
	} else {
		child.kill('SIGKILL');
	}
	if (!await waitForProcessClose(child, 5_000)) throw new Error('Discovery helper did not stop.');
}

export async function startExternalMcpDiscovery(options: {
	descriptor: WorkbenchProviderDescriptor;
	discoveryDirectory: string;
	helperScriptPath: string;
	powerShellExecutable: string;
	logger: ExternalMcpDiscoveryLogger;
	onUnexpectedClose?: () => void;
	parentProcessId?: number;
	removePath?: (path: string) => Promise<void>;
	onProvisionalServer?: (server: ExternalMcpDiscoveryServer) => void;
	onStartupCleanupSucceeded?: (server: ExternalMcpDiscoveryServer) => void;
}): Promise<ExternalMcpDiscoveryServer> {
	await ensureCurrentUserOnlyDirectory(options.discoveryDirectory);
	const pipeShortName = `kusto-workbench-${randomUUID()}`;
	const pipeName = `\\\\.\\pipe\\${pipeShortName}`;
	const announcementPath = join(options.discoveryDirectory, `${options.descriptor.instanceId}.json`);
	const temporaryAnnouncementPath = `${announcementPath}.${randomUUID()}.tmp`;
	const removePath = options.removePath ?? (path => rm(path, { force: true }));
	const child = spawn(options.powerShellExecutable, [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		options.helperScriptPath,
	], {
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let cleanupComplete = false;
	let shutdownRequested = false;
	let closePromise: Promise<void> | undefined;
	const unexpectedClose = () => {
		if (cleanupComplete || shutdownRequested) return;
		void removePath(announcementPath).catch(error => {
			options.logger.warn(`External MCP announcement cleanup will be retried: ${error instanceof Error ? error.message : String(error)}`);
		});
		options.logger.error('External MCP discovery helper stopped unexpectedly.');
		options.onUnexpectedClose?.();
	};
	const cleanupOwner = async (): Promise<void> => {
		if (cleanupComplete) return;
		if (closePromise) return closePromise;
		shutdownRequested = true;
		child.off('close', unexpectedClose);
		const operation = (async () => {
			const results = await Promise.allSettled([
				stopProcess(child),
				removePath(announcementPath),
				removePath(temporaryAnnouncementPath),
			]);
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map(result => result.reason);
			if (failures.length > 0) throw new AggregateError(failures, 'External MCP discovery shutdown failed.');
			cleanupComplete = true;
		})();
		closePromise = operation;
		try {
			await operation;
		} finally {
			if (closePromise === operation) closePromise = undefined;
		}
	};
	const server: ExternalMcpDiscoveryServer = {
		announcementPath,
		pipeName,
		close: cleanupOwner,
	};
	options.onProvisionalServer?.(server);
	try {
		child.stdin?.end(`${JSON.stringify({
			pipeName: pipeShortName,
			parentProcessId: options.parentProcessId ?? process.pid,
			announcementPath,
			response: JSON.stringify(options.descriptor),
		})}\n`);
		await waitForReady(child, 10_000);
		await writeFile(temporaryAnnouncementPath, `${JSON.stringify({
			protocolVersion: 1,
			instanceId: options.descriptor.instanceId,
			pipeName,
		})}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		await rename(temporaryAnnouncementPath, announcementPath);
		child.once('close', unexpectedClose);
		if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(unexpectedClose);
		return server;
	} catch (error) {
		try {
			await cleanupOwner();
		} catch (cleanupError) {
			const failures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
			throw new AggregateError([error, ...failures], 'External MCP discovery startup and cleanup failed.');
		}
		options.onStartupCleanupSucceeded?.(server);
		throw error;
	}
}