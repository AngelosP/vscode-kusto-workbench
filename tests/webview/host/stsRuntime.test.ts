import { describe, expect, it, vi } from 'vitest';
import { StsRuntime } from '../../../src/host/sql/stsRuntime';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

describe('StsRuntime', () => {
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