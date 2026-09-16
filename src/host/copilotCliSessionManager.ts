export interface CopilotCliLease {
	readonly id: string;
	readonly token: string;
	readonly authenticated: Promise<boolean>;
	revoke(): void;
}

export interface CopilotCliBridge {
	readonly endpoint: string;
	createLease(): CopilotCliLease;
	close(): Promise<void>;
}

export interface CopilotCliTerminal {
	readonly id: string;
	isClosed?(): boolean;
	show(): void;
	dispose(): void;
}

export interface CopilotCliPreparedLaunch {
	readonly [key: string]: unknown;
	dispose?(): void | Promise<void>;
}

export interface CopilotCliLaunchContext {
	readonly bridge: CopilotCliBridge;
	readonly lease: CopilotCliLease;
}

export interface CopilotCliSessionManagerDependencies {
	isEnabled(): boolean;
	prepareConnection?(signal: AbortSignal): Promise<void>;
	createBridge(): Promise<CopilotCliBridge>;
	prepareLaunch(context: CopilotCliLaunchContext): Promise<CopilotCliPreparedLaunch>;
	launchTerminal(launch: CopilotCliPreparedLaunch): Promise<CopilotCliTerminal>;
	showDisabledMessage(): Promise<void>;
}

export type CopilotCliConnectResult =
	| Readonly<{ started: false; reason: 'disabled' }>
	| Readonly<{ started: true; leaseId: string; terminalId: string }>;

type ActiveSession = Readonly<{
	lease: CopilotCliLease;
	launch: CopilotCliPreparedLaunch;
	terminal: CopilotCliTerminal;
}>;

function invokeSettlement(callback: () => void | Promise<void>): Promise<void> {
	return Promise.resolve().then(callback);
}

export class CopilotCliConnectionCancelledError extends Error {
	constructor() {
		super('Copilot CLI connection was cancelled.');
		this.name = 'CopilotCliConnectionCancelledError';
	}
}

export interface CopilotCliIntegrationService {
	connect(): Promise<void>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

export class LazyCopilotCliIntegration<T extends CopilotCliIntegrationService> {
	private service: T | undefined;
	private servicePromise: Promise<T> | undefined;
	private connectTail: Promise<void> = Promise.resolve();
	private stopPromise: Promise<void> = Promise.resolve();
	private generation = 0;
	private disposed = false;

	constructor(private readonly load: () => Promise<T>) {}

	captureGeneration(): number {
		return this.generation;
	}

	async connect(expectedGeneration: number = this.generation): Promise<void> {
		if (this.disposed) throw new Error('The Copilot CLI integration has been disposed.');
		const precedingStop = this.stopPromise;
		const run = async () => {
			await precedingStop;
			this.assertCurrent(expectedGeneration);
			const service = await this.getOrLoad();
			this.assertCurrent(expectedGeneration);
			await service.connect();
			if (expectedGeneration !== this.generation || this.disposed) {
				await service.stop();
				throw new CopilotCliConnectionCancelledError();
			}
		};
		const operation = this.connectTail.then(run, run);
		this.connectTail = operation.then(() => undefined, () => undefined);
		await operation;
	}

	async stop(): Promise<void> {
		this.generation++;
		const servicePromise = this.servicePromise;
		const connectTail = this.connectTail;
		const previousStop = this.stopPromise;
		const operation = (async () => {
			await previousStop;
			const service = servicePromise ? await servicePromise.catch(() => undefined) : undefined;
			const results = await Promise.allSettled([
				invokeSettlement(() => service?.stop()),
				connectTail,
			]);
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map(result => result.reason);
			if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI stop failed.');
		})();
		this.stopPromise = operation.then(() => undefined, () => undefined);
		await operation;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const failures: unknown[] = [];
		try {
			await this.stop();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.service?.dispose();
		} catch (error) {
			failures.push(error);
		}
		this.service = undefined;
		this.servicePromise = undefined;
		if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI disposal failed.');
	}

	private async getOrLoad(): Promise<T> {
		if (this.service) return this.service;
		if (!this.servicePromise) {
			this.servicePromise = this.load().then(service => {
				this.service = service;
				return service;
			}, error => {
				this.servicePromise = undefined;
				throw error;
			});
		}
		return this.servicePromise;
	}

	private assertCurrent(expectedGeneration: number): void {
		if (this.disposed || expectedGeneration !== this.generation) {
			throw new CopilotCliConnectionCancelledError();
		}
	}
}

export class CopilotCliSessionManager {
	private bridge: CopilotCliBridge | undefined;
	private bridgePromise: Promise<CopilotCliBridge> | undefined;
	private readonly sessions = new Map<string, ActiveSession>();
	private disposed = false;
	private generation = 0;
	private pendingConnections = 0;
	private readonly pendingPreflights = new Set<AbortController>();
	private readonly terminalCleanups = new Set<Promise<void>>();

	constructor(private readonly dependencies: CopilotCliSessionManagerDependencies) {}

	async connect(): Promise<CopilotCliConnectResult> {
		if (this.disposed) throw new Error('The Copilot CLI integration has been disposed.');
		if (!this.dependencies.isEnabled()) {
			await this.dependencies.showDisabledMessage();
			return { started: false, reason: 'disabled' };
		}

		const generation = this.generation;
		const preflight = new AbortController();
		this.pendingPreflights.add(preflight);
		this.pendingConnections++;
		let outcome: CopilotCliConnectResult | undefined;
		let failure: unknown;
		try {
			await this.dependencies.prepareConnection?.(preflight.signal);
			this.assertCurrent(generation);
			const bridge = await this.getOrCreateBridge();
			this.assertCurrent(generation);
			const lease = bridge.createLease();
			let launch: CopilotCliPreparedLaunch | undefined;
			let terminal: CopilotCliTerminal | undefined;
			try {
				launch = await this.dependencies.prepareLaunch({ bridge, lease });
				this.assertCurrent(generation);
				terminal = await this.dependencies.launchTerminal(launch);
				this.assertCurrent(generation);
				if (terminal.isClosed?.()) throw new CopilotCliConnectionCancelledError();
				if (this.sessions.has(terminal.id)) {
					throw new Error(`Copilot CLI terminal identity was reused: ${terminal.id}`);
				}
				this.sessions.set(terminal.id, { lease, launch, terminal });
				try {
					terminal.show();
				} catch (error) {
					this.sessions.delete(terminal.id);
					throw error;
				}
				outcome = { started: true, leaseId: lease.id, terminalId: terminal.id };
			} catch (error) {
				const failures: unknown[] = [error];
				try {
					terminal?.dispose();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
				try {
					lease.revoke();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
				try {
					await launch?.dispose?.();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
				failure = failures.length === 1
					? error
					: new AggregateError(failures, 'Copilot CLI provisional session cleanup failed.');
			}
		} catch (error) {
			failure = error;
		} finally {
			this.pendingPreflights.delete(preflight);
			this.pendingConnections--;
			try {
				await this.closeBridgeIfIdle();
			} catch (cleanupError) {
				failure = failure === undefined
					? cleanupError
					: new AggregateError([failure, cleanupError], 'Copilot CLI connection cleanup failed.');
			}
		}
		if (failure !== undefined) throw failure;
		return outcome!;
	}

	handleTerminalClosed(terminalId: string): Promise<void> {
		const session = this.sessions.get(terminalId);
		if (!session) return Promise.resolve();
		this.sessions.delete(terminalId);
		const operation = (async () => {
			const results = await Promise.allSettled([
				invokeSettlement(() => session.lease.revoke()),
				invokeSettlement(() => session.launch.dispose?.()),
				invokeSettlement(() => this.closeBridgeIfIdle()),
			]);
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map(result => result.reason);
			if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI terminal cleanup failed.');
		})();
		this.terminalCleanups.add(operation);
		void operation.finally(() => this.terminalCleanups.delete(operation)).catch(() => undefined);
		return operation;
	}

	async stop(): Promise<void> {
		this.generation++;
		for (const preflight of this.pendingPreflights) preflight.abort('Copilot CLI integration stopped.');
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		const failures: unknown[] = [];
		for (const session of sessions) {
			try {
				session.lease.revoke();
			} catch (error) {
				failures.push(error);
			}
			try {
				session.terminal.dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		const settlements = [
			invokeSettlement(() => this.closeBridge()),
			...sessions.map(session => invokeSettlement(() => session.launch.dispose?.())),
			...this.terminalCleanups,
		];
		const results = await Promise.allSettled(settlements);
		failures.push(...results
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason));
		if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI shutdown failed.');
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.stop();
	}

	private async getOrCreateBridge(): Promise<CopilotCliBridge> {
		if (this.bridge) return this.bridge;
		if (!this.bridgePromise) {
			this.bridgePromise = this.dependencies.createBridge().then(bridge => {
				this.bridge = bridge;
				return bridge;
			}, error => {
				this.bridgePromise = undefined;
				throw error;
			});
		}
		return this.bridgePromise;
	}

	private assertCurrent(generation: number): void {
		if (this.disposed || generation !== this.generation) {
			throw new CopilotCliConnectionCancelledError();
		}
	}

	private async closeBridgeIfIdle(): Promise<void> {
		if (this.sessions.size > 0 || this.pendingConnections > 0) return;
		await this.closeBridge();
	}

	private async closeBridge(): Promise<void> {
		const bridgePromise = this.bridgePromise;
		const bridge = this.bridge ?? (bridgePromise ? await bridgePromise : undefined);
		if (this.bridge === bridge) this.bridge = undefined;
		if (this.bridgePromise === bridgePromise) this.bridgePromise = undefined;
		await bridge?.close();
	}
}