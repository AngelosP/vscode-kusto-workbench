import * as vscode from 'vscode';
import type { WorkbenchLogger } from '../workbenchLogger';
import { ensureSts, invalidateStsCache } from './stsDownloader';
import { StsProcessManager } from './stsProcessManager';

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
	createProcessManager: (binaryPath: string, logPath: string, output: WorkbenchLogger) => StsProcessManager;
}

const defaultDependencies: StsRuntimeDependencies = {
	ensureSts,
	invalidateStsCache,
	createProcessManager: (binaryPath, logPath, output) => new StsProcessManager(binaryPath, logPath, output),
};

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