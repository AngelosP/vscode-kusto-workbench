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

describe('StsRuntime', () => {
	it('removes an abandoned protected sandbox after a prior crash', async () => {
		const sandbox = path.join(os.tmpdir(), `kusto-workbench-sts-lnt-${process.pid}-abandoned-test`);
		fs.mkdirSync(sandbox, { recursive: true });
		fs.writeFileSync(path.join(sandbox, 'orphaned-result.tmp'), 'secret', 'utf8');

		await cleanupAbandonedProtectedStsSandboxes();

		expect(fs.existsSync(sandbox)).toBe(false);
	});

	it('deletes the isolated protected runtime sandbox after stopping its process', async () => {
		let sandbox = '';
		const manager = {
			epoch: 1, isRunning: true, isFailed: false, ready: Promise.resolve(),
			start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
			onDidFail: vi.fn(() => ({ dispose: vi.fn() })),
		} as any;
		const dependencies = {
			ensureSts: vi.fn(async () => 'sts-binary'),
			invalidateStsCache: vi.fn(async () => undefined),
			createProcessManager: vi.fn((_binary: string, _logs: string, _output: unknown, launch: any) => {
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
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
			dependencies as any,
		);

		await runtime.getProcessManager();
		expect(fs.existsSync(path.join(sandbox, 'buffered-result.tmp'))).toBe(true);
		await runtime.dispose();

		expect(manager.stop).toHaveBeenCalledOnce();
		expect(fs.existsSync(sandbox)).toBe(false);
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