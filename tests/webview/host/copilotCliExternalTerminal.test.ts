import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
	EXTERNAL_CLI_BROKER_SCRIPT,
	EXTERNAL_CLI_RUNNER_SCRIPT,
	createExternalCliLaunchDescriptor,
	launchExternalCopilotCliTerminal,
} from '../../../src/host/copilotCliExternalTerminal';
import { CopilotCliConnectionCancelledError } from '../../../src/host/copilotCliSessionManager';
import { createCopilotCliMcpConfig } from '../../../src/host/copilotCliIntegration';

function createBrokerProcess(pid = 1234): {
	process: ChildProcess;
	stdout: PassThrough;
	stderr: PassThrough;
	exit(code?: number): void;
} {
	const emitter = new EventEmitter() as ChildProcess;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.defineProperties(emitter, {
		pid: { value: pid, configurable: true },
		exitCode: { value: null, writable: true, configurable: true },
		stdout: { value: stdout, configurable: true },
		stderr: { value: stderr, configurable: true },
		kill: { value: vi.fn(() => true), configurable: true },
	});
	return {
		process: emitter,
		stdout,
		stderr,
		exit: (code = 0) => {
			Object.defineProperty(emitter, 'exitCode', { value: code, writable: true, configurable: true });
			emitter.emit('exit', code, null);
			emitter.emit('close', code, null);
		},
	};
}

function launchOptions(process: ChildProcess, signal: AbortSignal, overrides: Record<string, unknown> = {}) {
	return {
		powerShellExecutable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		taskkillExecutable: 'C:\\Windows\\System32\\taskkill.exe',
		brokerScriptPath: 'C:\\state path\\external-broker.ps1',
		descriptorPath: 'C:\\state path\\external-launch.json',
		startPath: 'C:\\state path\\start',
		stopPath: 'C:\\state path\\stop',
		exitedPath: 'C:\\state path\\exited',
		visiblePidPath: 'C:\\state path\\visible-pid',
		workingDirectory: 'C:\\workspace path',
		signal,
		onClosed: vi.fn(),
		spawnBroker: vi.fn(() => process),
		writeMarker: vi.fn(async () => {}),
		terminateBrokerTree: vi.fn(async () => true),
		startupTimeoutMs: 100,
		shutdownTimeoutMs: 5,
		...overrides,
	};
}

describe('Copilot CLI external terminal', () => {
	const processExists = (processId: number): boolean => {
		try {
			process.kill(processId, 0);
			return true;
		} catch {
			return false;
		}
	};
	const waitFor = async (condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (condition()) return;
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		throw new Error('Timed out waiting for external process state.');
	};

	it('keeps the bearer out of generated scripts and safely encodes metacharacter paths', () => {
		const bearer = 'BEARER_SENTINEL_SHOULD_NOT_APPEAR';
		const credential = JSON.stringify(createCopilotCliMcpConfig({
			serverName: 'kusto-workbench-test',
			endpoint: 'http://127.0.0.1:43210/mcp',
			toolNames: ['listSections'],
			token: bearer,
		}));
		const descriptor = createExternalCliLaunchDescriptor({
			cliExecutable: 'C:\\Tools & Apps\\copilot-é.exe',
			arguments: ['--additional-mcp-config=@C:\\State & Data\\用户\\mcp.json', '--agent=kusto-workbench-cli'],
			workingDirectory: 'C:\\Workspaces\\用户-O\'Brien & $pace',
			powerShellExecutable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			taskkillExecutable: 'C:\\Windows\\System32\\taskkill.exe',
			runnerScriptPath: 'C:\\State & Data\\O\'Brien\\external-runner.ps1',
			descriptorPath: 'C:\\State & Data\\O\'Brien\\external-launch.json',
			startPath: 'C:\\State & Data\\start',
			stopPath: 'C:\\State & Data\\stop',
			exitedPath: 'C:\\State & Data\\exited',
			visiblePidPath: 'C:\\State & Data\\visible-pid',
		});
		const parsed = JSON.parse(descriptor);
		const runnerCommand = Buffer.from(parsed.encodedRunnerCommand, 'base64').toString('utf16le');

		expect(credential).toContain(bearer);
		expect(`${EXTERNAL_CLI_BROKER_SCRIPT}${EXTERNAL_CLI_RUNNER_SCRIPT}${descriptor}`).not.toContain(bearer);
		expect(parsed.arguments).toEqual([
			'--additional-mcp-config=@C:\\State & Data\\用户\\mcp.json',
			'--agent=kusto-workbench-cli',
		]);
		expect(parsed.cliExecutable).toBe('C:\\Tools & Apps\\copilot-é.exe');
		expect(parsed.workingDirectory).toBe('C:\\Workspaces\\用户-O\'Brien & $pace');
		expect(EXTERNAL_CLI_RUNNER_SCRIPT).toContain('Get-Content -LiteralPath $DescriptorPath -Raw -Encoding UTF8');
		expect(EXTERNAL_CLI_BROKER_SCRIPT).toContain('Get-Content -LiteralPath $DescriptorPath -Raw -Encoding UTF8');
		expect(EXTERNAL_CLI_BROKER_SCRIPT).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
		expect(EXTERNAL_CLI_BROKER_SCRIPT.indexOf('CreateAndAssignCurrentProcess()'))
			.toBeLessThan(EXTERNAL_CLI_BROKER_SCRIPT.indexOf('$terminal = Start-Process'));
		expect(runnerCommand).toContain("'C:\\State & Data\\O''Brien\\external-runner.ps1'");
		expect(runnerCommand).toContain("'C:\\State & Data\\O''Brien\\external-launch.json'");
	});

	it.runIf(process.platform === 'win32')('runs Windows PowerShell with a BOM-less UTF-8 descriptor in a Unicode path', () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-cli-用户-é-'));
		try {
			const workingDirectory = join(root, "工作区 O'Brien & space");
			mkdirSync(workingDirectory);
			const runnerScriptPath = join(root, 'external-runner-é.ps1');
			const descriptorPath = join(root, 'external-launch-用户.json');
			const startPath = join(root, 'start');
			const stopPath = join(root, 'stop');
			const outputPath = join(root, 'result-é.txt');
			const dummyCliPath = join(root, 'dummy-cli-用户.js');
			const systemRoot = process.env.SystemRoot!;
			const powerShellExecutable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
			writeFileSync(runnerScriptPath, EXTERNAL_CLI_RUNNER_SCRIPT, 'utf8');
			writeFileSync(dummyCliPath, "require('node:fs').writeFileSync(process.argv[2], process.cwd(), 'utf8');\n", 'utf8');
			writeFileSync(descriptorPath, createExternalCliLaunchDescriptor({
				cliExecutable: process.execPath,
				arguments: [dummyCliPath, outputPath],
				workingDirectory,
				powerShellExecutable,
				taskkillExecutable: join(systemRoot, 'System32', 'taskkill.exe'),
				runnerScriptPath,
				descriptorPath,
				startPath,
				stopPath,
				exitedPath: join(root, 'exited'),
				visiblePidPath: join(root, 'visible-pid'),
			}), 'utf8');
			writeFileSync(startPath, '1\n', 'utf8');

			execFileSync(powerShellExecutable, [
				'-NoLogo',
				'-NoProfile',
				'-ExecutionPolicy',
				'Bypass',
				'-File',
				runnerScriptPath,
				'-DescriptorPath',
				descriptorPath,
			], { timeout: 15_000, windowsHide: true });

			expect(readFileSync(outputPath, 'utf8')).toBe(workingDirectory);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('kills the visible console when the real Job Object broker exits unexpectedly', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-cli-job-'));
		let visibleProcessId: number | undefined;
		let cliProcessId: number | undefined;
		let brokerProcessId: number | undefined;
		const systemRoot = process.env.SystemRoot!;
		const powerShellExecutable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const taskkillExecutable = join(systemRoot, 'System32', 'taskkill.exe');
		try {
			const brokerScriptPath = join(root, 'external-broker.ps1');
			const runnerScriptPath = join(root, 'external-runner.ps1');
			const descriptorPath = join(root, 'external-launch.json');
			const startPath = join(root, 'start');
			const visiblePidPath = join(root, 'visible-pid');
			const cliPidPath = join(root, 'cli-pid');
			const dummyCliPath = join(root, 'dummy-cli.js');
			writeFileSync(brokerScriptPath, EXTERNAL_CLI_BROKER_SCRIPT, 'utf8');
			writeFileSync(runnerScriptPath, EXTERNAL_CLI_RUNNER_SCRIPT, 'utf8');
			writeFileSync(dummyCliPath, "require('node:fs').writeFileSync(process.argv[2], String(process.pid), 'utf8'); setInterval(() => {}, 1000);\n", 'utf8');
			writeFileSync(descriptorPath, createExternalCliLaunchDescriptor({
				cliExecutable: process.execPath,
				arguments: [dummyCliPath, cliPidPath],
				workingDirectory: root,
				powerShellExecutable,
				taskkillExecutable,
				runnerScriptPath,
				descriptorPath,
				startPath,
				stopPath: join(root, 'stop'),
				exitedPath: join(root, 'exited'),
				visiblePidPath,
			}), 'utf8');

			const broker = spawn(powerShellExecutable, [
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-File',
				brokerScriptPath,
				'-DescriptorPath',
				descriptorPath,
			], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			brokerProcessId = broker.pid;
			let stdout = '';
			broker.stdout.on('data', chunk => { stdout += chunk.toString(); });
			await waitFor(() => stdout.includes('KUSTO_WORKBENCH_EXTERNAL_CLI:'));
			visibleProcessId = Number(readFileSync(visiblePidPath, 'utf8').trim());
			expect(processExists(visibleProcessId)).toBe(true);
			writeFileSync(startPath, '1\n', 'utf8');
			await waitFor(() => {
				try {
					cliProcessId = Number(readFileSync(cliPidPath, 'utf8'));
					return Number.isSafeInteger(cliProcessId) && processExists(cliProcessId);
				} catch {
					return false;
				}
			});

			broker.kill();
			await new Promise<void>(resolve => broker.once('close', () => resolve()));
			await waitFor(() => !processExists(visibleProcessId!) && !processExists(cliProcessId!));

			expect(processExists(visibleProcessId)).toBe(false);
			expect(processExists(cliProcessId)).toBe(false);
		} finally {
			if (cliProcessId !== undefined && processExists(cliProcessId)) {
				execFileSync(taskkillExecutable, ['/PID', String(cliProcessId), '/T', '/F'], { windowsHide: true });
			}
			if (visibleProcessId !== undefined && processExists(visibleProcessId)) {
				execFileSync(taskkillExecutable, ['/PID', String(visibleProcessId), '/T', '/F'], { windowsHide: true });
			}
			if (brokerProcessId !== undefined && processExists(brokerProcessId)) {
				execFileSync(taskkillExecutable, ['/PID', String(brokerProcessId), '/T', '/F'], { windowsHide: true });
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('uses structured broker arguments and gates CLI startup until session admission', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const writeMarker = vi.fn(async () => {});
		const spawnBroker = vi.fn(() => broker.process);
		const options = launchOptions(broker.process, controller.signal, { writeMarker, spawnBroker });
		const launch = launchExternalCopilotCliTerminal(options);
		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,"visibleProcessId":4321}\n');

		const terminal = await launch;
		expect(writeMarker).not.toHaveBeenCalled();
		expect(spawnBroker).toHaveBeenCalledWith(
			options.powerShellExecutable,
			expect.arrayContaining(['-File', options.brokerScriptPath, '-DescriptorPath', options.descriptorPath]),
			expect.objectContaining({ windowsHide: true, cwd: options.workingDirectory }),
		);

		await terminal.show();
		expect(writeMarker).toHaveBeenCalledWith(options.startPath);
		broker.exit();
		await vi.waitFor(() => expect(options.onClosed).toHaveBeenCalledWith(terminal.id));
	});

	it('rejects presentation when the broker closes during start-marker publication', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		let releaseStartMarker: (() => void) | undefined;
		const startMarker = new Promise<void>(resolve => { releaseStartMarker = resolve; });
		const writeMarker = vi.fn((path: string) => path.endsWith('start') ? startMarker : Promise.resolve());
		const options = launchOptions(broker.process, controller.signal, { writeMarker });
		const terminal = await launchExternalCopilotCliTerminal(options);
		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,"visibleProcessId":4321}\n');
		const show = terminal.show();
		await vi.waitFor(() => expect(writeMarker).toHaveBeenCalledWith(options.startPath));

		broker.process.emit('close', 1, null);
		releaseStartMarker?.();

		await expect(show).rejects.toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(terminal.isClosed?.()).toBe(true);
		await terminal.dispose();
		expect(options.onClosed).not.toHaveBeenCalled();
	});

	it('accepts a startup receipt fragmented across stdout chunks', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const options = launchOptions(broker.process, controller.signal);
		const terminal = await launchExternalCopilotCliTerminal(options);
		let settled = false;
		const show = terminal.show().then(() => { settled = true; });

		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,');
		await Promise.resolve();
		expect(settled).toBe(false);
		broker.stdout.write('"visibleProcessId":4321}\n');

		await show;
		expect(settled).toBe(true);
		broker.exit();
		await vi.waitFor(() => expect(options.onClosed).toHaveBeenCalledWith(terminal.id));
	});

	it('cancels startup before admission and stops the broker without starting the CLI', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const writeMarker = vi.fn(async path => {
			if (path.endsWith('stop')) queueMicrotask(() => broker.exit(1));
		});
		const options = launchOptions(broker.process, controller.signal, { writeMarker });
		const terminal = await launchExternalCopilotCliTerminal(options);

		controller.abort();

		await expect(terminal.show()).rejects.toBeInstanceOf(CopilotCliConnectionCancelledError);
		await terminal.dispose();
		expect(writeMarker).toHaveBeenCalledWith(options.stopPath);
		expect(writeMarker).not.toHaveBeenCalledWith(options.startPath);
		expect(options.terminateBrokerTree).not.toHaveBeenCalled();
	});

	it('rejects a broker that exits before reporting the visible console', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const options = launchOptions(broker.process, controller.signal);
		const terminal = await launchExternalCopilotCliTerminal(options);

		broker.exit(1);

		await expect(terminal.show()).rejects.toThrow('exited before creating a console');
		await terminal.dispose();
		expect(options.writeMarker).not.toHaveBeenCalledWith(options.startPath);
		expect(options.onClosed).not.toHaveBeenCalled();
	});

	it('treats natural console closure as one session close notification', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const options = launchOptions(broker.process, controller.signal);
		const launch = launchExternalCopilotCliTerminal(options);
		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,"visibleProcessId":4321}\n');
		const terminal = await launch;
		await terminal.show();

		broker.exit();
		broker.process.emit('exit', 0, null);

		await vi.waitFor(() => expect(options.onClosed).toHaveBeenCalledOnce());
		expect(options.onClosed).toHaveBeenCalledWith(terminal.id);
	});

	it('awaits graceful shutdown and falls back to the retained broker tree when needed', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const terminateBrokerTree = vi.fn(async () => {
			broker.exit(1);
			return true;
		});
		const options = launchOptions(broker.process, controller.signal, {
			terminateBrokerTree,
			shutdownTimeoutMs: 1,
		});
		const launch = launchExternalCopilotCliTerminal(options);
		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,"visibleProcessId":4321}\n');
		const terminal = await launch;
		await terminal.show();

		await terminal.dispose();

		expect(options.writeMarker).toHaveBeenCalledWith(options.stopPath);
		expect(terminateBrokerTree).toHaveBeenCalledWith(broker.process, options.taskkillExecutable);
		expect(options.onClosed).toHaveBeenCalledOnce();
	});

	it('retains a failed broker-tree termination for a later disposal retry', async () => {
		const broker = createBrokerProcess();
		const controller = new AbortController();
		const terminateBrokerTree = vi.fn()
			.mockRejectedValueOnce(new Error('tree cleanup failed'))
			.mockImplementationOnce(async () => {
				broker.exit(1);
				return true;
			});
		const options = launchOptions(broker.process, controller.signal, {
			terminateBrokerTree,
			shutdownTimeoutMs: 1,
		});
		const terminal = await launchExternalCopilotCliTerminal(options);
		broker.stdout.write('KUSTO_WORKBENCH_EXTERNAL_CLI:{"protocol":1,"visibleProcessId":4321}\n');
		await terminal.show();

		await expect(terminal.dispose()).rejects.toThrow('tree cleanup failed');
		expect(options.onClosed).not.toHaveBeenCalled();

		await terminal.dispose();
		expect(terminateBrokerTree).toHaveBeenCalledTimes(2);
		expect(options.onClosed).toHaveBeenCalledOnce();
	});
});