import { describe, expect, it, vi } from 'vitest';
import {
	CopilotCliConnectionCancelledError,
	CopilotCliSessionManager,
	LazyCopilotCliIntegration,
	type CopilotCliBridge,
	type CopilotCliIntegrationService,
	type CopilotCliTerminal,
} from '../../../src/host/copilotCliSessionManager';

function createBridge() {
	const revoke = vi.fn();
	const close = vi.fn(async () => {});
	let leaseSequence = 0;
	const bridge: CopilotCliBridge = {
		endpoint: 'http://127.0.0.1:43210/mcp',
		createLease: vi.fn(() => ({
			id: `lease-${++leaseSequence}`,
			token: `token-${leaseSequence}`,
			authenticated: Promise.resolve(true),
			revoke,
		})),
		close,
	};
	return { bridge, revoke, close };
}

function createTerminal(id: string): CopilotCliTerminal {
	return {
		id,
		show: vi.fn(),
		dispose: vi.fn(),
	};
}

describe('CopilotCliSessionManager', () => {
	it('does no bridge, launch, or file work while the opt-in setting is disabled', async () => {
		const createBridge = vi.fn();
		const prepareConnection = vi.fn();
		const prepareLaunch = vi.fn();
		const launchTerminal = vi.fn();
		const showDisabledMessage = vi.fn(async () => {});
		const manager = new CopilotCliSessionManager({
			isEnabled: () => false,
			prepareConnection,
			createBridge,
			prepareLaunch,
			launchTerminal,
			showDisabledMessage,
		});

		const result = await manager.connect();

		expect(result).toEqual({ started: false, reason: 'disabled' });
		expect(createBridge).not.toHaveBeenCalled();
		expect(prepareConnection).not.toHaveBeenCalled();
		expect(prepareLaunch).not.toHaveBeenCalled();
		expect(launchTerminal).not.toHaveBeenCalled();
		expect(showDisabledMessage).toHaveBeenCalledOnce();
	});

	it('starts only on explicit connect and assigns a distinct lease to each CLI terminal', async () => {
		const { bridge, revoke, close } = createBridge();
		const firstTerminal = createTerminal('terminal-1');
		const secondTerminal = createTerminal('terminal-2');
		const terminals = [firstTerminal, secondTerminal];
		const createBridgeImpl = vi.fn(async () => bridge);
		const prepareLaunch = vi.fn(async ({ lease }: { lease: { id: string } }) => ({
			name: `launch-${lease.id}`,
		}));
		const launchTerminal = vi.fn(async () => terminals.shift()!);
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: createBridgeImpl,
			prepareLaunch,
			launchTerminal,
			showDisabledMessage: vi.fn(async () => {}),
		});

		expect(createBridgeImpl).not.toHaveBeenCalled();
		const first = await manager.connect();
		const second = await manager.connect();

		expect(first).toMatchObject({ started: true, leaseId: 'lease-1', terminalId: 'terminal-1' });
		expect(second).toMatchObject({ started: true, leaseId: 'lease-2', terminalId: 'terminal-2' });
		expect(createBridgeImpl).toHaveBeenCalledOnce();
		expect(bridge.createLease).toHaveBeenCalledTimes(2);
		expect(prepareLaunch).toHaveBeenCalledTimes(2);
		expect(launchTerminal).toHaveBeenCalledTimes(2);

		await manager.handleTerminalClosed('terminal-1');
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();

		await manager.handleTerminalClosed('terminal-2');
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledOnce();
	});

	it('revokes a lease and tears down an otherwise idle bridge when launch fails', async () => {
		const { bridge, revoke, close } = createBridge();
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ name: 'launch' }),
			launchTerminal: async () => { throw new Error('CLI missing'); },
			showDisabledMessage: vi.fn(async () => {}),
		});

		await expect(manager.connect()).rejects.toThrow('CLI missing');
		expect(revoke).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('does not launch a terminal when stop wins during bridge startup', async () => {
		const { bridge, close } = createBridge();
		let finishBridge: ((value: CopilotCliBridge) => void) | undefined;
		const bridgeStarted = new Promise<void>(resolve => {
			finishBridge = value => {
				resolve();
				bridgePromiseResolve?.(value);
			};
		});
		let bridgePromiseResolve: ((value: CopilotCliBridge) => void) | undefined;
		const delayedBridge = new Promise<CopilotCliBridge>(resolve => { bridgePromiseResolve = resolve; });
		const launchTerminal = vi.fn();
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: () => delayedBridge,
			prepareLaunch: async () => ({ name: 'late-launch' }),
			launchTerminal,
			showDisabledMessage: vi.fn(async () => {}),
		});

		const connect = manager.connect();
		await Promise.resolve();
		const stop = manager.stop();
		finishBridge?.(bridge);
		await bridgeStarted;

		await stop;
		await expect(connect).rejects.toThrow('cancelled');
		expect(launchTerminal).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('aborts a pending connection preflight before waiting for its tail', async () => {
		const createBridge = vi.fn();
		let observedSignal: AbortSignal | undefined;
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			prepareConnection: signal => new Promise((_resolve, reject) => {
				observedSignal = signal;
				signal.addEventListener('abort', () => reject(new CopilotCliConnectionCancelledError()), { once: true });
			}),
			createBridge,
			prepareLaunch: vi.fn(),
			launchTerminal: vi.fn(),
			showDisabledMessage: vi.fn(async () => {}),
		});
		const connect = manager.connect().catch(error => error);
		await vi.waitFor(() => expect(observedSignal).toBeDefined());

		await manager.stop();

		expect(observedSignal?.aborted).toBe(true);
		expect(await connect).toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(createBridge).not.toHaveBeenCalled();
	});

	it('removes an inserted session when terminal presentation throws', async () => {
		const { bridge, revoke, close } = createBridge();
		const terminal = createTerminal('terminal-show-failure');
		terminal.show = vi.fn(() => { throw new Error('show failed'); });
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ name: 'launch' }),
			launchTerminal: async () => terminal,
			showDisabledMessage: vi.fn(async () => {}),
		});

		await expect(manager.connect()).rejects.toThrow('show failed');
		expect(terminal.dispose).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('retires a terminal that closed before session admission', async () => {
		const { bridge, revoke, close } = createBridge();
		const terminal = createTerminal('terminal-closed-early');
		terminal.isClosed = () => true;
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ name: 'launch' }),
			launchTerminal: async () => terminal,
			showDisabledMessage: vi.fn(async () => {}),
		});

		await expect(manager.connect()).rejects.toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(terminal.show).not.toHaveBeenCalled();
		expect(terminal.dispose).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('revokes every lease and disposes every terminal before awaiting cleanup', async () => {
		const revoked: string[] = [];
		const close = vi.fn(async () => {});
		let leaseSequence = 0;
		const bridge: CopilotCliBridge = {
			endpoint: 'http://127.0.0.1:43210/mcp',
			createLease: () => {
				const id = `lease-${++leaseSequence}`;
				return {
					id,
					token: `token-${leaseSequence}`,
					authenticated: Promise.resolve(true),
					revoke: () => { revoked.push(id); },
				};
			},
			close,
		};
		let releaseFirstCleanup: (() => void) | undefined;
		const firstCleanup = new Promise<void>(resolve => { releaseFirstCleanup = resolve; });
		const cleanupCalls: string[] = [];
		const firstTerminal = createTerminal('terminal-1');
		const secondTerminal = createTerminal('terminal-2');
		const terminals = [firstTerminal, secondTerminal];
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async ({ lease }) => ({
				dispose: async () => {
					cleanupCalls.push(lease.id);
					if (lease.id === 'lease-1') await firstCleanup;
				},
			}),
			launchTerminal: async () => terminals.shift()!,
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();
		await manager.connect();

		const stop = manager.stop();
		await vi.waitFor(() => expect(cleanupCalls).toEqual(['lease-1', 'lease-2']));
		expect(revoked).toEqual(['lease-1', 'lease-2']);
		expect(firstTerminal.dispose).toHaveBeenCalledOnce();
		expect(secondTerminal.dispose).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();

		releaseFirstCleanup?.();
		await stop;
	});

	it('keeps the shared bridge alive when an existing terminal closes during another Connect', async () => {
		const { bridge, close } = createBridge();
		const terminals = [createTerminal('terminal-1'), createTerminal('terminal-2')];
		let finishSecondLaunch: (() => void) | undefined;
		const secondLaunchReady = new Promise<void>(resolve => { finishSecondLaunch = resolve; });
		let launchSequence = 0;
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => {
				if (++launchSequence === 2) await secondLaunchReady;
				return { dispose: vi.fn() };
			},
			launchTerminal: async () => terminals.shift()!,
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();
		const secondConnect = manager.connect();
		await vi.waitFor(() => expect(bridge.createLease).toHaveBeenCalledTimes(2));

		await manager.handleTerminalClosed('terminal-1');
		expect(close).not.toHaveBeenCalled();
		finishSecondLaunch?.();
		expect(await secondConnect).toMatchObject({ started: true, terminalId: 'terminal-2' });
		expect(close).not.toHaveBeenCalled();

		await manager.stop();
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes the bridge even when natural-close file cleanup rejects', async () => {
		const { bridge, revoke, close } = createBridge();
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ dispose: async () => { throw new Error('cleanup failed'); } }),
			launchTerminal: async () => createTerminal('terminal-1'),
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();

		await expect(manager.handleTerminalClosed('terminal-1')).rejects.toThrow('terminal cleanup failed');
		expect(revoke).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('runs launch and bridge cleanup when natural-close lease revocation throws', async () => {
		const cleanup = vi.fn();
		const close = vi.fn(async () => {});
		const bridge: CopilotCliBridge = {
			endpoint: 'http://127.0.0.1:43210/mcp',
			createLease: () => ({
				id: 'lease-1',
				token: 'token-1',
				authenticated: Promise.resolve(true),
				revoke: () => { throw new Error('revoke failed'); },
			}),
			close,
		};
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ dispose: cleanup }),
			launchTerminal: async () => createTerminal('terminal-1'),
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();

		await expect(manager.handleTerminalClosed('terminal-1')).rejects.toThrow('terminal cleanup failed');

		expect(cleanup).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('waits for natural-close cleanup already in flight before Stop settles', async () => {
		const { bridge } = createBridge();
		let releaseCleanup: (() => void) | undefined;
		const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async () => ({ dispose: () => cleanup }),
			launchTerminal: async () => createTerminal('terminal-1'),
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();
		const naturalClose = manager.handleTerminalClosed('terminal-1');
		let stopSettled = false;
		const stop = manager.stop().then(() => { stopSettled = true; });

		await Promise.resolve();
		expect(stopSettled).toBe(false);
		releaseCleanup?.();
		await Promise.all([naturalClose, stop]);
		expect(stopSettled).toBe(true);
	});

	it('continues revoking and disposing later sessions after synchronous teardown errors', async () => {
		const actions: string[] = [];
		let leaseSequence = 0;
		const bridge: CopilotCliBridge = {
			endpoint: 'http://127.0.0.1:43210/mcp',
			createLease: () => {
				const sequence = ++leaseSequence;
				return {
					id: `lease-${sequence}`,
					token: `token-${sequence}`,
					authenticated: Promise.resolve(true),
					revoke: () => {
						actions.push(`revoke-${sequence}`);
						if (sequence === 1) throw new Error('revoke failed');
					},
				};
			},
			close: async () => { actions.push('bridge-close'); },
		};
		const firstTerminal = createTerminal('terminal-1');
		firstTerminal.dispose = () => {
			actions.push('dispose-1');
			throw new Error('dispose failed');
		};
		const secondTerminal = createTerminal('terminal-2');
		secondTerminal.dispose = () => { actions.push('dispose-2'); };
		const terminals = [firstTerminal, secondTerminal];
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async ({ lease }) => ({ dispose: () => { actions.push(`cleanup-${lease.id}`); } }),
			launchTerminal: async () => terminals.shift()!,
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();
		await manager.connect();

		await expect(manager.stop()).rejects.toThrow('shutdown failed');

		expect(actions).toEqual([
			'revoke-1', 'dispose-1', 'revoke-2', 'dispose-2',
			'bridge-close', 'cleanup-lease-1', 'cleanup-lease-2',
		]);
	});

	it('runs every provisional cleanup action when another session keeps the bridge alive', async () => {
		const actions: string[] = [];
		let leaseSequence = 0;
		const bridge: CopilotCliBridge = {
			endpoint: 'http://127.0.0.1:43210/mcp',
			createLease: () => {
				const sequence = ++leaseSequence;
				return {
					id: `lease-${sequence}`,
					token: `token-${sequence}`,
					authenticated: Promise.resolve(true),
					revoke: () => {
						actions.push(`revoke-${sequence}`);
						if (sequence === 2) throw new Error('provisional revoke failed');
					},
				};
			},
			close: async () => { actions.push('bridge-close'); },
		};
		const firstTerminal = createTerminal('terminal-1');
		const provisionalTerminal = createTerminal('terminal-2');
		provisionalTerminal.dispose = () => {
			actions.push('dispose-provisional');
			throw new Error('provisional dispose failed');
		};
		let launchSequence = 0;
		const manager = new CopilotCliSessionManager({
			isEnabled: () => true,
			createBridge: async () => bridge,
			prepareLaunch: async ({ lease }) => ({
				dispose: () => {
					actions.push(`cleanup-${lease.id}`);
					if (lease.id === 'lease-2') throw new Error('provisional cleanup failed');
				},
			}),
			launchTerminal: async () => {
				if (++launchSequence === 1) return firstTerminal;
				return provisionalTerminal;
			},
			showDisabledMessage: vi.fn(async () => {}),
		});
		await manager.connect();
		provisionalTerminal.isClosed = () => true;

		await expect(manager.connect()).rejects.toThrow('provisional session cleanup failed');

		expect(actions).toEqual([
			'dispose-provisional',
			'revoke-2',
			'cleanup-lease-2',
		]);
		await manager.stop();
		expect(actions).toContain('revoke-1');
		expect(actions).toContain('bridge-close');
	});
});

describe('LazyCopilotCliIntegration', () => {
	function createService(): CopilotCliIntegrationService & {
		connect: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	} {
		return {
			connect: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
		};
	}

	it('does not load a never-used integration when stopped', async () => {
		const load = vi.fn();
		const integration = new LazyCopilotCliIntegration(load);

		await integration.stop();

		expect(load).not.toHaveBeenCalled();
	});

	it('makes stop a barrier against a cold import that finishes late', async () => {
		const service = createService();
		let finishLoad: ((service: typeof service) => void) | undefined;
		const load = vi.fn(() => new Promise<typeof service>(resolve => { finishLoad = resolve; }));
		const integration = new LazyCopilotCliIntegration(load);
		const generation = integration.captureGeneration();

		const connect = integration.connect(generation);
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		const stop = integration.stop();
		finishLoad?.(service);

		await stop;
		await expect(connect).rejects.toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(service.connect).not.toHaveBeenCalled();
		expect(service.stop).toHaveBeenCalledOnce();
	});

	it('invalidates queued connect calls when stop wins', async () => {
		const service = createService();
		let finishFirst: (() => void) | undefined;
		service.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; }));
		service.stop.mockImplementation(async () => { finishFirst?.(); });
		const integration = new LazyCopilotCliIntegration(async () => service);
		const generation = integration.captureGeneration();

		const first = integration.connect(generation).catch(error => error);
		const second = integration.connect(generation).catch(error => error);
		await vi.waitFor(() => expect(service.connect).toHaveBeenCalledOnce());
		const stop = integration.stop();

		await stop;
		expect(await first).toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(await second).toBeInstanceOf(CopilotCliConnectionCancelledError);
		expect(service.connect).toHaveBeenCalledOnce();
		expect(service.stop).toHaveBeenCalled();
	});

	it('waits for the captured connect tail even when service stop rejects', async () => {
		const service = createService();
		let releaseConnect: (() => void) | undefined;
		service.connect.mockImplementationOnce(() => new Promise<void>(resolve => { releaseConnect = resolve; }));
		service.stop.mockRejectedValue(new Error('stop failed'));
		const integration = new LazyCopilotCliIntegration(async () => service);
		const generation = integration.captureGeneration();
		const connect = integration.connect(generation).catch(error => error);
		await vi.waitFor(() => expect(service.connect).toHaveBeenCalledOnce());
		let stopSettled = false;
		const stop = integration.stop().then(
			() => { stopSettled = true; return undefined; },
			error => { stopSettled = true; return error; },
		);

		await Promise.resolve();
		expect(stopSettled).toBe(false);
		releaseConnect?.();
		expect(await stop).toBeInstanceOf(AggregateError);
		expect(await connect).toBeInstanceOf(Error);
	});

	it('disposes the loaded service even when stop rejects', async () => {
		const service = createService();
		const integration = new LazyCopilotCliIntegration(async () => service);
		await integration.connect();
		service.stop.mockRejectedValue(new Error('stop failed'));

		await expect(integration.dispose()).rejects.toThrow('disposal failed');
		expect(service.dispose).toHaveBeenCalledOnce();
	});
});