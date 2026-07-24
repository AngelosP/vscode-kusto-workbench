import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkbenchLogger } from '../workbenchLogger';
import { ensureSts, invalidateStsCache } from './stsDownloader';
import { StsProcessManager, type StsProcessLaunchOptions } from './stsProcessManager';

export interface StsRuntimeLike {
	getProcessManager(): Promise<StsProcessManager>;
	dispose(): Promise<void>;
}

export interface StsRuntimeManagerChange {
	previous?: StsProcessManager;
	current?: StsProcessManager;
}

export interface StsRuntimeDependencies {
	ensureSts: typeof ensureSts;
	invalidateStsCache: typeof invalidateStsCache;
	createProcessManager: (binaryPath: string, logPath: string, output: WorkbenchLogger, launchOptions?: StsProcessLaunchOptions) => StsProcessManager;
}

const defaultDependencies: StsRuntimeDependencies = {
	ensureSts,
	invalidateStsCache,
	createProcessManager: (binaryPath, logPath, output, launchOptions) => new StsProcessManager(binaryPath, logPath, output, launchOptions),
};

const PROTECTED_STS_TEMP_PREFIX = 'kusto-workbench-sts-lnt-';
const activeProtectedStsRoots = new Set<string>();
const PROTECTED_STS_CHILD_PID_FILE = 'sts-child.pid';
const PROTECTED_STS_MAX_LIVE_AGE_MS = 24 * 60 * 60 * 1000;

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return String((error as NodeJS.ErrnoException | undefined)?.code || '') === 'EPERM';
	}
}

function terminateProcess(pid: number): void {
	if (!processIsAlive(pid)) return;
	try {
		if (process.platform === 'win32') {
			require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
				stdio: 'ignore', windowsHide: true,
			});
		} else {
			process.kill(pid, 'SIGKILL');
		}
	} catch { /* deletion retries still run */ }
}

export async function cleanupAbandonedProtectedStsSandboxes(output?: WorkbenchLogger): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(PROTECTED_STS_TEMP_PREFIX)) continue;
		const root = path.join(os.tmpdir(), entry.name);
		if (activeProtectedStsRoots.has(root)) continue;
		const pidMatch = entry.name.slice(PROTECTED_STS_TEMP_PREFIX.length).match(/^(\d+)-/);
		const ownerPid = Number(pidMatch?.[1] || 0);
		let ageMs = 0;
		try { ageMs = Date.now() - (await fs.promises.stat(root)).mtimeMs; } catch { /* delete below */ }
		if (ownerPid !== process.pid && processIsAlive(ownerPid) && ageMs < PROTECTED_STS_MAX_LIVE_AGE_MS) continue;
		try {
			let childPid = 0;
			try { childPid = Number(await fs.promises.readFile(path.join(root, PROTECTED_STS_CHILD_PID_FILE), 'utf8')); } catch { /* no child marker */ }
			if (childPid && childPid !== process.pid) terminateProcess(childPid);
			await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			output?.warn(`[sql-lnt] Failed to remove an abandoned isolated STS sandbox: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export async function createProtectedStsRuntime(
	context: vscode.ExtensionContext,
	output: WorkbenchLogger,
	dependencies: StsRuntimeDependencies = defaultDependencies,
): Promise<StsRuntimeLike> {
	await cleanupAbandonedProtectedStsSandboxes(output);
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${PROTECTED_STS_TEMP_PREFIX}${process.pid}-`));
	activeProtectedStsRoots.add(root);
	const home = path.join(root, 'home');
	const localAppData = path.join(root, 'local-app-data');
	const appData = path.join(root, 'app-data');
	const cache = path.join(root, 'cache');
	const config = path.join(root, 'config');
	const data = path.join(root, 'data');
	const state = path.join(root, 'state');
	const dotnetBundle = path.join(root, 'dotnet-bundle');
	const nuget = path.join(root, 'nuget');
	const logs = path.join(root, 'logs');
	await Promise.all([home, localAppData, appData, cache, config, data, state, dotnetBundle, nuget, logs].map(directory =>
		fs.promises.mkdir(directory, { recursive: true })));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TEMP: root,
		TMP: root,
		TMPDIR: root,
		HOME: home,
		USERPROFILE: home,
		LOCALAPPDATA: localAppData,
		APPDATA: appData,
		XDG_CACHE_HOME: cache,
		XDG_CONFIG_HOME: config,
		XDG_DATA_HOME: data,
		XDG_STATE_HOME: state,
		DOTNET_CLI_HOME: home,
		DOTNET_BUNDLE_EXTRACT_BASE_DIR: dotnetBundle,
		NUGET_PACKAGES: nuget,
		NUGET_HTTP_CACHE_PATH: path.join(nuget, 'http-cache'),
	};
	const runtime = new StsRuntime(context, output, {
		...dependencies,
		createProcessManager: (binaryPath, _logPath, logger) => dependencies.createProcessManager(
			binaryPath,
			logs,
			logger,
			{
				cwd: root,
				env,
				suppressProcessOutput: true,
				onProcessStarted: pid => fs.promises.writeFile(
					path.join(root, PROTECTED_STS_CHILD_PID_FILE), String(pid), 'utf8',
				),
			},
		),
	});
	let disposed = false;
	return {
		getProcessManager: () => runtime.getProcessManager(),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				await runtime.dispose();
			} finally {
				try {
					await fs.promises.rm(root, {
						recursive: true,
						force: true,
						maxRetries: 10,
						retryDelay: 100,
					});
				} finally {
					activeProtectedStsRoots.delete(root);
				}
			}
		},
	};
}

export class StsRuntime implements StsRuntimeLike {
	private processManager: StsProcessManager | undefined;
	private startPromise: Promise<StsProcessManager> | undefined;
	private managerFailureSubscription: vscode.Disposable | undefined;
	private readonly managerChangeEmitter = new vscode.EventEmitter<StsRuntimeManagerChange>();
	readonly onDidChangeProcessManager = this.managerChangeEmitter.event;
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: WorkbenchLogger,
		private readonly dependencies: StsRuntimeDependencies = defaultDependencies,
	) {}

	getProcessManager(): Promise<StsProcessManager> {
		if (this.disposed) return Promise.reject(new Error('SQL Tools Service runtime is disposed.'));
		if (this.startPromise) return this.startPromise;
		if (this.processManager && !this.processManager.isFailed) {
			const manager = this.processManager;
			if (manager.isRunning) return Promise.resolve(manager);
			return manager.ready.then(() => {
				if (!manager.isRunning) throw new Error('SQL Tools Service failed to restart.');
				return manager;
			});
		}
		if (this.processManager?.isFailed) this.processManager = undefined;

		this.startPromise = this.startCore().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		let manager = this.processManager;
		if (!manager && this.startPromise) {
			try { manager = await this.startPromise; } catch { /* startup already failed */ }
		}
		this.processManager = undefined;
		this.managerFailureSubscription?.dispose();
		this.managerFailureSubscription = undefined;
		if (manager) await manager.stop();
		this.managerChangeEmitter.dispose();
	}

	private async startCore(): Promise<StsProcessManager> {
		let firstError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const binaryPath = await this.dependencies.ensureSts(this.context.globalStorageUri.fsPath, this.output);
			if (!binaryPath) throw new Error('SQL Tools Service is unavailable. Retry when the runtime can be downloaded.');
			if (this.disposed) throw new Error('SQL Tools Service runtime is disposed.');

			const manager = this.dependencies.createProcessManager(binaryPath, this.context.logUri.fsPath, this.output);
			try {
				await manager.start();
				await manager.ready;
				if (!manager.isRunning) throw new Error('SQL Tools Service failed to start.');
				if (this.disposed) throw new Error('SQL Tools Service runtime is disposed.');
				const previous = this.processManager;
				this.processManager = manager;
				this.managerFailureSubscription?.dispose();
				this.managerFailureSubscription = manager.onDidFail(() => {
					if (this.processManager !== manager || this.disposed) return;
					this.processManager = undefined;
					this.managerFailureSubscription?.dispose();
					this.managerFailureSubscription = undefined;
					this.managerChangeEmitter.fire({ previous: manager });
					void this.getProcessManager().catch(error => {
						this.output.error(`[sts] Replacement runtime failed: ${error instanceof Error ? error.message : String(error)}`);
					});
				});
				this.managerChangeEmitter.fire({ previous, current: manager });
				return manager;
			} catch (error) {
				if (this.processManager === manager) this.processManager = undefined;
				try { await manager.stop(); } catch { /* preserve startup error */ }
				if (attempt === 0 && manager.epoch === 0 && !this.disposed) {
					firstError = error;
					this.output.warn('[sts] Initial runtime launch failed; reinstalling the verified cache once.');
					await this.dependencies.invalidateStsCache(this.context.globalStorageUri.fsPath, this.output);
					continue;
				}
				throw firstError ?? error;
			}
		}
		throw firstError ?? new Error('SQL Tools Service failed to start.');
	}
}