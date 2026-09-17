export interface CopilotCliLease {
	readonly id: string;
	readonly token: string;
	readonly authenticated: Promise<boolean>;
	revoke(): void;
}

export type CopilotCliConnectionTarget = 'integrated' | 'external';

export interface CopilotCliBridge {
	readonly endpoint: string;
	createLease(): CopilotCliLease;
	close(): Promise<void>;
}

export interface CopilotCliTerminal {
	readonly id: string;
	isClosed?(): boolean;
	show(): void | Promise<void>;
	dispose(): void | Promise<void>;
}

export interface CopilotCliPreparedLaunch {
	readonly [key: string]: unknown;
	dispose?(): void | Promise<void>;
}

export interface CopilotCliLaunchContext {
	readonly bridge: CopilotCliBridge;
	readonly lease: CopilotCliLease;
	readonly target: CopilotCliConnectionTarget;
	readonly signal: AbortSignal;
	retainLaunch(launch: CopilotCliPreparedLaunch): void;
}

export interface CopilotCliSessionManagerDependencies {
	isEnabled(): boolean;
	prepareConnection?(signal: AbortSignal, target: CopilotCliConnectionTarget): Promise<void>;
	createBridge(): Promise<CopilotCliBridge>;
	prepareLaunch(context: CopilotCliLaunchContext): Promise<CopilotCliPreparedLaunch>;
	launchTerminal(
		launch: CopilotCliPreparedLaunch,
		target: CopilotCliConnectionTarget,
		signal: AbortSignal,
	): Promise<CopilotCliTerminal>;
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

type ProvisionalSession = Readonly<{
	lease: CopilotCliLease;
	launch?: CopilotCliPreparedLaunch;
	terminal?: CopilotCliTerminal;
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
	connect(target?: CopilotCliConnectionTarget): Promise<void>;
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

	async connect(
		expectedGeneration: number = this.generation,
		target: CopilotCliConnectionTarget = 'integrated',
	): Promise<void> {
		if (this.disposed) throw new Error('The Copilot CLI integration has been disposed.');
		const precedingStop = this.stopPromise;
		const run = async () => {
			await precedingStop;
			this.assertCurrent(expectedGeneration);
			const service = await this.getOrLoad();
			this.assertCurrent(expectedGeneration);
			await service.connect(target);
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
		if (this.disposed && !this.service && !this.servicePromise) return;
		this.disposed = true;
		let stopFailure: unknown;
		try {
			await this.stop();
		} catch (error) {
			stopFailure = error;
		}
		const service = this.service ?? (this.servicePromise ? await this.servicePromise.catch(() => undefined) : undefined);
		if (!service) {
			this.servicePromise = undefined;
			if (stopFailure !== undefined) throw new AggregateError([stopFailure], 'Copilot CLI disposal failed.');
			return;
		}
		try {
			await service.dispose();
		} catch (error) {
			throw new AggregateError(
				stopFailure === undefined ? [error] : [stopFailure, error],
				'Copilot CLI disposal failed.',
			);
		}
		this.service = undefined;
		this.servicePromise = undefined;
		if (stopFailure !== undefined) throw new AggregateError([stopFailure], 'Copilot CLI disposal failed.');
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
	private readonly provisionalSessions = new Map<string, ProvisionalSession>();
	private disposed = false;
	private generation = 0;
	private pendingConnections = 0;
	private readonly pendingPreflights = new Set<AbortController>();
	private readonly terminalCleanups = new Set<Promise<void>>();
	private readonly stoppingSessionIds = new Set<string>();

	constructor(private readonly dependencies: CopilotCliSessionManagerDependencies) {}

	async connect(target: CopilotCliConnectionTarget = 'integrated'): Promise<CopilotCliConnectResult> {
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
			await this.dependencies.prepareConnection?.(preflight.signal, target);
			this.assertCurrent(generation);
			const bridge = await this.getOrCreateBridge();
			this.assertCurrent(generation);
			const lease = bridge.createLease();
			let launch: CopilotCliPreparedLaunch | undefined;
			let terminal: CopilotCliTerminal | undefined;
			try {
				const preparedLaunch = await this.dependencies.prepareLaunch({
					bridge,
					lease,
					target,
					signal: preflight.signal,
					retainLaunch: retained => {
						if (launch && launch !== retained) {
							throw new Error('Copilot CLI launch cleanup ownership was registered more than once.');
						}
						launch = retained;
					},
				});
				launch = preparedLaunch;
				this.assertCurrent(generation);
				terminal = await this.dependencies.launchTerminal(launch, target, preflight.signal);
				this.assertCurrent(generation);
				if (terminal.isClosed?.()) throw new CopilotCliConnectionCancelledError();
				if (this.sessions.has(terminal.id)) {
					throw new Error(`Copilot CLI terminal identity was reused: ${terminal.id}`);
				}
				this.sessions.set(terminal.id, { lease, launch, terminal });
				try {
					await terminal.show();
					this.assertCurrent(generation);
					if (terminal.isClosed?.()) throw new CopilotCliConnectionCancelledError();
				} catch (error) {
					this.sessions.delete(terminal.id);
					throw error;
				}
				outcome = { started: true, leaseId: lease.id, terminalId: terminal.id };
			} catch (error) {
				const provisional = { lease, launch, terminal };
				this.provisionalSessions.set(lease.id, provisional);
				try {
					await this.cleanupProvisionalSession(lease.id, provisional);
				} catch (cleanupError) {
					failure = new AggregateError([error, cleanupError], 'Copilot CLI provisional session cleanup failed.');
				}
				if (failure === undefined) failure = error;
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

	private async cleanupProvisionalSession(
		leaseId: string,
		session: ProvisionalSession,
	): Promise<void> {
		const failures: unknown[] = [];
		try {
			session.lease.revoke();
		} catch (error) {
			failures.push(error);
		}
		let terminalStopped = true;
		try {
			await session.terminal?.dispose();
		} catch (error) {
			terminalStopped = false;
			failures.push(error);
		}
		if (terminalStopped) {
			try {
				await session.launch?.dispose?.();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'Copilot CLI provisional cleanup failed.');
		}
		if (this.provisionalSessions.get(leaseId) === session) this.provisionalSessions.delete(leaseId);
	}

	handleTerminalClosed(terminalId: string): Promise<void> {
		const session = this.sessions.get(terminalId);
		if (!session || this.stoppingSessionIds.has(terminalId)) return Promise.resolve();
		const operation = (async () => {
			const results = await Promise.allSettled([
				invokeSettlement(() => session.lease.revoke()),
				invokeSettlement(() => session.launch.dispose?.()),
			]);
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map(result => result.reason);
			if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI terminal cleanup failed.');
			if (this.sessions.get(terminalId) === session) this.sessions.delete(terminalId);
			await this.closeBridgeIfIdle();
		})();
		this.terminalCleanups.add(operation);
		void operation.finally(() => this.terminalCleanups.delete(operation)).catch(() => undefined);
		return operation;
	}

	async stop(): Promise<void> {
		this.generation++;
		for (const preflight of this.pendingPreflights) preflight.abort('Copilot CLI integration stopped.');
		const sessions = [...this.sessions.entries()];
		const provisionalSessions = [...this.provisionalSessions.entries()];
		for (const [terminalId] of sessions) this.stoppingSessionIds.add(terminalId);
		const failures: unknown[] = [];
		for (const [, session] of sessions) {
			try {
				session.lease.revoke();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const [, session] of provisionalSessions) {
			try {
				session.lease.revoke();
			} catch {
				// cleanupProvisionalSession retries after bridge admission is closed.
			}
		}
		try {
			await this.closeBridge();
		} catch (error) {
			failures.push(error);
		}
		const sessionResults = await Promise.allSettled(sessions.map(async ([terminalId, session]) => {
			await session.terminal.dispose();
			await session.launch.dispose?.();
			if (this.sessions.get(terminalId) === session) this.sessions.delete(terminalId);
		}));
		for (const [terminalId] of sessions) this.stoppingSessionIds.delete(terminalId);
		failures.push(...sessionResults
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason));
		const provisionalResults = await Promise.allSettled(
			provisionalSessions.map(([leaseId, session]) => this.cleanupProvisionalSession(leaseId, session)),
		);
		failures.push(...provisionalResults
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason));
		const cleanupResults = await Promise.allSettled(this.terminalCleanups);
		failures.push(...cleanupResults
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason));
		if (failures.length > 0) throw new AggregateError(failures, 'Copilot CLI shutdown failed.');
	}

	async dispose(): Promise<void> {
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
		await bridge?.close();
		if (this.bridge === bridge) this.bridge = undefined;
		if (this.bridgePromise === bridgePromise) this.bridgePromise = undefined;
	}
}