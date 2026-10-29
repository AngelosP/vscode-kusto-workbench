import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupAbandonedProtectedStsSandboxes, createProtectedStsRuntime, StsRuntime } from '../../../src/host/sql/stsRuntime';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createInstallationRuntime() {
	const manager = {
		epoch: 0, isRunning: false, isFailed: false, ready: Promise.resolve(),
		start: vi.fn(async () => { manager.epoch = 1; manager.isRunning = true; }),
		stop: vi.fn(async () => { manager.isRunning = false; }),
		onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
	};
	const dependencies = {
		ensureSts: vi.fn<() => Promise<string | null>>(async () => 'verified-binary'),
		invalidateStsCache: vi.fn(async () => undefined),
		createProcessManager: vi.fn((_binary: string, _logs: string, _output: unknown) => manager as never),
	};
	const runtime = new StsRuntime({
		globalStorageUri: { fsPath: 'storage' }, logUri: { fsPath: 'logs' },
	} as never, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, dependencies);
	return { runtime, dependencies, manager };
}

describe('StsRuntime', () => {
	it('shares installation-only preparation with ordinary startup and skips verification for its healthy manager', async () => {
		const { runtime, dependencies, manager } = createInstallationRuntime();
		const installation = deferred<string | null>();
		dependencies.ensureSts.mockReturnValue(installation.promise);
		const preparation = runtime.prepareInstallation();
		const startup = runtime.getProcessManager();
		const second = runtime.prepareInstallation();
		try {
			expect(dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(dependencies.ensureSts).toHaveBeenCalledWith('storage', expect.anything());
			expect(dependencies.createProcessManager).not.toHaveBeenCalled();
			installation.resolve('verified-shared-binary');
			await Promise.all([preparation, second]);
			await expect(startup).resolves.toBe(manager);
			expect(manager.start).toHaveBeenCalledOnce();
			expect(manager.isRunning).toBe(true);
			await runtime.prepareInstallation();
			expect(await runtime.getProcessManager()).toBe(manager);
			expect(dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(dependencies.createProcessManager).toHaveBeenCalledExactlyOnceWith('verified-shared-binary', 'logs', expect.anything());
		} finally {
			installation.resolve('verified-shared-binary');
			await runtime.dispose();
		}
	});

	it('reverifies an unused prepared binary on the next preparation instead of caching its path forever', async () => {
		const { runtime, dependencies } = createInstallationRuntime();
		dependencies.ensureSts.mockResolvedValueOnce('first-verified-binary').mockResolvedValueOnce('next-verified-binary');
		try {
			await runtime.prepareInstallation();
			expect(dependencies.createProcessManager).not.toHaveBeenCalled();
			await runtime.prepareInstallation();
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
			expect(dependencies.createProcessManager).not.toHaveBeenCalled();
			await runtime.getProcessManager();
			expect(dependencies.createProcessManager).toHaveBeenCalledExactlyOnceWith('next-verified-binary', 'logs', expect.anything());
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
		} finally {
			await runtime.dispose();
		}
	});

	it.each(['rejected', 'unavailable'])('clears %s preparation without starting a process or retrying until the next caller', async failure => {
		const { runtime, dependencies } = createInstallationRuntime();
		if (failure === 'rejected') dependencies.ensureSts.mockRejectedValueOnce(new Error('installer failed'));
		else dependencies.ensureSts.mockResolvedValueOnce(null);
		try {
			await expect(runtime.prepareInstallation()).rejects.toThrow(failure === 'rejected' ? 'installer failed' : 'unavailable');
			expect(dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(dependencies.createProcessManager).not.toHaveBeenCalled();
			await runtime.prepareInstallation();
			await runtime.getProcessManager();
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
			expect(dependencies.createProcessManager).toHaveBeenCalledOnce();
			expect(dependencies.invalidateStsCache).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});

	it('shares first-launch reinstall with preparation and never reuses the quarantined binary', async () => {
		const { runtime, dependencies, manager } = createInstallationRuntime();
		const invalidation = deferred<void>();
		dependencies.invalidateStsCache.mockReturnValue(invalidation.promise);
		dependencies.ensureSts.mockResolvedValueOnce('old-verified-binary').mockResolvedValueOnce('fresh-verified-binary');
		const broken = { ...manager, epoch: 0, isRunning: false, isFailed: true,
			start: vi.fn(async () => { throw new Error('support file missing'); }), stop: vi.fn(async () => undefined) };
		dependencies.createProcessManager.mockReturnValueOnce(broken as never);
		await runtime.prepareInstallation();
		const startup = runtime.getProcessManager();
		try {
			await vi.waitFor(() => expect(dependencies.invalidateStsCache).toHaveBeenCalledOnce());
			const preparation = runtime.prepareInstallation();
			expect(dependencies.ensureSts).toHaveBeenCalledOnce();
			expect(dependencies.createProcessManager).toHaveBeenCalledOnce();
			invalidation.resolve(undefined);
			await preparation;
			await expect(startup).resolves.toBe(manager);
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
			expect(dependencies.createProcessManager.mock.calls.map(([binary]) => binary))
				.toEqual(['old-verified-binary', 'fresh-verified-binary']);
			expect(broken.stop).toHaveBeenCalledOnce();
		} finally {
			invalidation.resolve(undefined);
			await startup.catch(() => undefined);
			await runtime.dispose();
		}
	});

	it('does not add an implicit third installation when first-launch reinstall is unavailable', async () => {
		const { runtime, dependencies, manager } = createInstallationRuntime();
		dependencies.ensureSts.mockResolvedValueOnce('old-verified-binary').mockResolvedValueOnce(null);
		const broken = { ...manager, epoch: 0, isRunning: false, isFailed: true,
			start: vi.fn(async () => { throw new Error('support file missing'); }), stop: vi.fn(async () => undefined) };
		dependencies.createProcessManager.mockReturnValueOnce(broken as never);
		try {
			await runtime.prepareInstallation();
			await expect(runtime.getProcessManager()).rejects.toThrow('unavailable');
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
			expect(dependencies.invalidateStsCache).toHaveBeenCalledOnce();
			expect(dependencies.createProcessManager).toHaveBeenCalledOnce();
			await runtime.prepareInstallation();
			expect(dependencies.ensureSts).toHaveBeenCalledTimes(3);
		} finally {
			await runtime.dispose();
		}
	});

	it('rejects installation preparation across disposal without creating a process', async () => {
		const { runtime, dependencies } = createInstallationRuntime();
		const installation = deferred<string | null>();
		dependencies.ensureSts.mockReturnValue(installation.promise);
		const preparation = runtime.prepareInstallation().catch(error => error);
		await runtime.dispose();
		installation.resolve('verified-binary');
		await expect(preparation).resolves.toMatchObject({ message: 'SQL Tools Service runtime is disposed.' });
		await expect(runtime.prepareInstallation()).rejects.toThrow('disposed');
		expect(dependencies.ensureSts).toHaveBeenCalledOnce();
		expect(dependencies.createProcessManager).not.toHaveBeenCalled();
	});

	it('removes an abandoned protected sandbox after a prior crash', async () => {
		const sandbox = path.join(os.tmpdir(), `kusto-workbench-sts-lnt-${process.pid}-abandoned-test`);
		fs.mkdirSync(sandbox, { recursive: true });
		fs.writeFileSync(path.join(sandbox, 'orphaned-result.tmp'), 'secret', 'utf8');

		await cleanupAbandonedProtectedStsSandboxes();

		expect(fs.existsSync(sandbox)).toBe(false);
	});

	it('deletes the isolated protected runtime sandbox after stopping its process', async () => {
		let sandbox = '';
		const output = {
			trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
			show: vi.fn(), log: vi.fn(),
		};
		const manager = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn((_binary: string, _logs: string, protectedOutput: any, launch: any) => {
				sandbox = launch.cwd;
				expect(launch.env.TEMP).toBe(sandbox);
				expect(launch.env.TMP).toBe(sandbox);
				expect(launch.env.LOCALAPPDATA).toContain(sandbox);
				expect(launch.env.XDG_CONFIG_HOME).toContain(sandbox);
				expect(launch.env.XDG_DATA_HOME).toContain(sandbox);
				expect(launch.env.XDG_STATE_HOME).toContain(sandbox);
				expect(launch.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR).toContain(sandbox);
				expect(launch.env.NUGET_PACKAGES).toContain(sandbox);
				expect(launch.suppressProcessOutput).toBe(true);
				expect(typeof launch.onProcessStarted).toBe('function');
				protectedOutput.warn('SecretLedger PrivateCustomers');
				protectedOutput.error(new Error('PrivateObject failed'));
				fs.writeFileSync(path.join(sandbox, 'buffered-result.tmp'), 'secret', 'utf8');
				return manager;
			}),
		};
		const context = {
			globalStorageUri: { fsPath: path.join(os.tmpdir(), 'kw-sts-runtime-cache') },
			logUri: { fsPath: 'logs' },
		} as any;
		const runtime = await createProtectedStsRuntime(
			context,
			output as any,
			dependencies as any,
		);

		await runtime.getProcessManager();
		expect(fs.existsSync(path.join(sandbox, 'buffered-result.tmp'))).toBe(true);
		await runtime.dispose();

		expect(manager.stop).toHaveBeenCalledOnce();
		expect(fs.existsSync(sandbox)).toBe(false);
		const durableLog = [
			...output.trace.mock.calls,
			...output.debug.mock.calls,
			...output.info.mock.calls,
			...output.warn.mock.calls,
			...output.error.mock.calls,
		].flat().join('\n');
		expect(durableLog).toContain('[sql-lnt] Isolated STS diagnostic suppressed.');
		expect(durableLog).not.toContain('SecretLedger');
		expect(durableLog).not.toContain('PrivateCustomers');
		expect(durableLog).not.toContain('PrivateObject');
	});

	it('shares one cold start and publishes only an initialized manager', async () => {
		const startup = deferred<void>();
		const manager = {
			epoch: 0,
			isRunning: false,
			isFailed: false,
			ready: startup.promise,
			start: vi.fn(async () => {
				await startup.promise;
				manager.epoch = 1;
				manager.isRunning = true;
			}),
			stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn(() => manager),
		};
		const runtime = new StsRuntime({
			globalStorageUri: { fsPath: 'storage' },
			logUri: { fsPath: 'logs' },
		} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, dependencies as any);

		const first = runtime.getProcessManager();
		const second = runtime.getProcessManager();
		await Promise.resolve();
		expect(dependencies.createProcessManager).toHaveBeenCalledTimes(1);
		expect(manager.epoch).toBe(0);

		startup.resolve(undefined);
		const [firstManager, secondManager] = await Promise.all([first, second]);
		expect(firstManager).toBe(manager);
		expect(secondManager).toBe(manager);
		expect(manager.epoch).toBe(1);
		expect(manager.isRunning).toBe(true);
	});

	it('replaces an exhausted manager and publishes generation changes', async () => {
		const failureHandlers: Array<(error: Error) => void> = [];
		const first = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn((handler: (error: Error) => void) => {
				failureHandlers.push(handler);
				return { dispose: vi.fn() };
			}),
		} as any;
		const second = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn()
				.mockReturnValueOnce(first)
				.mockReturnValueOnce(second),
		};
		const runtime = new StsRuntime({
			globalStorageUri: { fsPath: 'storage' }, logUri: { fsPath: 'logs' },
		} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, dependencies as any);
		const changes: any[] = [];
		runtime.onDidChangeProcessManager(change => changes.push(change));

		expect(await runtime.getProcessManager()).toBe(first);
		failureHandlers[0](new Error('exhausted'));
		await vi.waitFor(() => expect(dependencies.createProcessManager).toHaveBeenCalledTimes(2));
		expect(await runtime.getProcessManager()).toBe(second);
		expect(changes).toEqual([
			{ previous: undefined, current: first },
			{ previous: first },
			{ previous: undefined, current: second },
		]);
	});

	it('restarts a running manager on demand and publishes the replacement', async () => {
		const first = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const second = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
		};
		const runtime = new StsRuntime({
			globalStorageUri: { fsPath: 'storage' }, logUri: { fsPath: 'logs' },
		} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, dependencies as any);
		const changes: any[] = [];
		runtime.onDidChangeProcessManager(change => changes.push(change));

		expect(await runtime.getProcessManager()).toBe(first);
		await runtime.restart();

		expect(first.stop).toHaveBeenCalledOnce();
		expect(await runtime.getProcessManager()).toBe(second);
		expect(changes).toEqual([
			{ previous: undefined, current: first },
			{ previous: first },
			{ previous: undefined, current: second },
		]);
	});

	it('holds manager acquisition until the old manager finishes stopping', async () => {
		const stopGate = deferred<void>();
		const first = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => stopGate.promise),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const second = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
		};
		const runtime = new StsRuntime({
			globalStorageUri: { fsPath: 'storage' }, logUri: { fsPath: 'logs' },
		} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, dependencies as any);
		expect(await runtime.getProcessManager()).toBe(first);

		const restart = runtime.restart();
		const acquisition = runtime.getProcessManager();
		let acquired = false;
		void acquisition.then(() => { acquired = true; });
		await Promise.resolve();
		expect(acquired).toBe(false);
		expect(dependencies.createProcessManager).toHaveBeenCalledOnce();

		stopGate.resolve(undefined);
		await restart;
		await expect(acquisition).resolves.toBe(second);
	});

	it('quarantines and reinstalls once when a cached runtime fails before initialization', async () => {
		const broken = {
			epoch: 0, isRunning: false, isFailed: true, ready: Promise.reject(new Error('support file missing')),
			start: vi.fn(async () => { throw new Error('support file missing'); }), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		void broken.ready.catch(() => undefined);
		const healthy = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn().mockReturnValueOnce(broken).mockReturnValueOnce(healthy),
		};
		const runtime = new StsRuntime({
			globalStorageUri: { fsPath: 'storage' }, logUri: { fsPath: 'logs' },
		} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, dependencies as any);

		expect(await runtime.getProcessManager()).toBe(healthy);
		expect(dependencies.invalidateStsCache).toHaveBeenCalledWith('storage', expect.anything());
		expect(dependencies.ensureSts).toHaveBeenCalledTimes(2);
		expect(dependencies.createProcessManager).toHaveBeenCalledTimes(2);
	});
});