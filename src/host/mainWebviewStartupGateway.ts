import type * as vscode from 'vscode';

export const MAIN_WEBVIEW_DISPATCHER_READY_TYPE = 'mainWebviewDispatcherReady' as const;

type GatewayTraceEvent = 'received' | 'queued' | 'flushQueued';

export interface MainWebviewStartupGatewayOptions<TInbound> {
	panel: vscode.WebviewPanel;
	admitInbound(input: unknown): TInbound | undefined;
	prepareOutbound?(message: unknown): unknown | undefined;
	allowReentrantInbound?(message: TInbound): boolean;
	allowRetiredInbound?(message: TInbound): boolean;
	trace?(event: GatewayTraceEvent, message: TInbound, queuedCount: number): void;
}

type PendingOutbound = {
	message: unknown;
	resolve(delivered: boolean): void;
};

type PendingInbound<TInbound> = {
	message: TInbound;
	retirementEligible: boolean;
};

type CorrelatedMessage = { type?: unknown; [key: string]: unknown };

function hasCorrelationId(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}


export function isMainWebviewCorrelatedReply(input: unknown): boolean {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
	const message = input as CorrelatedMessage;
	const type = typeof message.type === 'string' ? message.type : '';
	switch (type) {
		case 'artifactCsvSaveData':
		case 'comparisonBoxEnsured':
		case 'documentReloadResult':
		case 'markdownDocumentCommandBarrierResult':
		case 'publishToPowerBIAck':
		case 'toolExecutionStarted':
		case 'toolResponse':
		case 'toolStateResponse':
			return hasCorrelationId(message.requestId);
		case 'kustoExecutionStartedAck':
			return hasCorrelationId(message.boxId)
				&& hasCorrelationId(message.executionId)
				&& hasCorrelationId(message.sectionInstanceId)
				&& Number.isSafeInteger(message.targetGeneration);
		case 'kustoPublicationAck':
			return hasCorrelationId(message.publicationId)
				&& (message.phase === 'staged' || message.phase === 'applied');
		case 'sqlComparisonAdmissionAck':
			return hasCorrelationId(message.requestId)
				&& hasCorrelationId(message.sourceBoxId)
				&& hasCorrelationId(message.comparisonBoxId)
				&& ['staged', 'committed', 'finalized', 'completed', 'rolledBack'].includes(String(message.phase));
		default:
			return false;
	}
}

function isDispatcherReadyMessage(input: unknown): boolean {
	return !!input
		&& typeof input === 'object'
		&& !Array.isArray(input)
		&& (input as Record<string, unknown>).type === MAIN_WEBVIEW_DISPATCHER_READY_TYPE;
}

export class MainWebviewStartupGateway<TInbound> implements vscode.Disposable {
	private readonly inboundSubscription: vscode.Disposable;
	private readonly panelDisposalSubscription: vscode.Disposable;
	private readonly inboundQueue: PendingInbound<TInbound>[] = [];
	private readonly outboundQueue: PendingOutbound[] = [];
	private inboundHandler?: (message: TInbound) => void | PromiseLike<void>;
	private inboundDrain?: Promise<void>;
	private retiredInboundDrain: Promise<void> = Promise.resolve();
	private outboundDrain?: Promise<void>;
	private dispatcherReady = false;
	private retired = false;
	private retiredInboundAdmissionOpen = true;
	private disposed = false;

	constructor(private readonly options: MainWebviewStartupGatewayOptions<TInbound>) {
		this.inboundSubscription = options.panel.webview.onDidReceiveMessage(input => this.receive(input));
		this.panelDisposalSubscription = options.panel.onDidDispose(() => this.retire());
	}

	async setInboundHandler(handler: (message: TInbound) => void | PromiseLike<void>): Promise<void> {
		if (this.disposed) return;
		if (this.inboundHandler && this.inboundHandler !== handler) {
			throw new Error('The main-webview inbound handler is already installed.');
		}
		this.inboundHandler = handler;
		if (this.retired) {
			const retained = this.inboundQueue.splice(0).filter(pending => pending.retirementEligible);
			for (const pending of retained) this.enqueueRetiredInbound(pending.message);
			await this.retiredInboundDrain;
			return;
		}
		if (this.inboundDrain) return this.inboundDrain;

		const drain = Promise.resolve().then(async () => {
			while (this.inboundQueue.length > 0) {
				const pending = this.inboundQueue.shift()!;
				const message = pending.message;
				if (this.retired) {
					if (pending.retirementEligible) this.enqueueRetiredInbound(message);
					continue;
				}
				this.options.trace?.('flushQueued', message, this.inboundQueue.length);
				try {
					await handler(message);
				} catch {
					// One rejected startup message must not strand later admitted traffic.
				}
			}
		});
		this.inboundDrain = drain;
		try {
			await drain;
		} finally {
			if (this.inboundDrain === drain) this.inboundDrain = undefined;
		}
		if (!this.disposed && this.inboundQueue.length > 0) {
			await this.setInboundHandler(handler);
		}
	}

	postMessage(message: unknown): Promise<boolean> {
		return this.enqueueOutbound(message).delivery;
	}

	postMessageFireAndForget(message: unknown): boolean {
		const queued = this.enqueueOutbound(message);
		void queued.delivery;
		return queued.accepted;
	}

	async closeRetiredInboundAdmission(): Promise<void> {
		this.retiredInboundAdmissionOpen = false;
		for (;;) {
			const tail = this.retiredInboundDrain;
			await tail;
			if (tail === this.retiredInboundDrain) return;
		}
	}

	retire(): void {
		if (this.retired) return;
		this.retired = true;
		for (const pending of this.outboundQueue.splice(0)) pending.resolve(false);
		const retained = this.inboundQueue.splice(0)
			.filter(pending => pending.retirementEligible);
		const handler = this.inboundHandler;
		if (handler && retained.length > 0) {
			for (const pending of retained) this.enqueueRetiredInbound(pending.message);
		} else if (retained.length > 0) {
			this.inboundQueue.push(...retained);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.retiredInboundAdmissionOpen = false;
		this.retire();
		this.inboundQueue.splice(0);
		this.inboundSubscription.dispose();
		this.panelDisposalSubscription.dispose();
	}

	private receive(input: unknown): void | Promise<void> {
		if (isDispatcherReadyMessage(input)) return this.markDispatcherReady();

		const message = this.options.admitInbound(input);
		if (message === undefined) return;
		const retirementEligible = this.options.allowRetiredInbound?.(message) === true;
		if (this.retired && (!this.retiredInboundAdmissionOpen || !retirementEligible)) return;

		this.options.trace?.('received', message, this.inboundQueue.length);
		if (this.retired && retirementEligible && this.inboundHandler) {
			return this.enqueueRetiredInbound(message);
		}
		if (!this.inboundHandler
			|| (this.inboundDrain && this.options.allowReentrantInbound?.(message) !== true)) {
			this.inboundQueue.push({ message, retirementEligible });
			this.options.trace?.('queued', message, this.inboundQueue.length);
			return;
		}
		return Promise.resolve(this.inboundHandler(message));
	}

	private enqueueRetiredInbound(message: TInbound): Promise<void> {
		const handler = this.inboundHandler;
		if (!handler) {
			this.inboundQueue.push({ message, retirementEligible: true });
			return Promise.resolve();
		}
		const delivery = this.retiredInboundDrain.then(async () => {
			this.options.trace?.('flushQueued', message, 0);
			try {
				await handler(message);
			} catch {
				// One rejected terminal message must not suppress later admitted close traffic.
			}
		});
		this.retiredInboundDrain = delivery;
		return delivery;
	}

	private async markDispatcherReady(): Promise<void> {
		if (this.retired || this.dispatcherReady) return;
		this.dispatcherReady = true;
		await this.drainOutbound();
	}

	private enqueueOutbound(message: unknown): { accepted: boolean; delivery: Promise<boolean> } {
		if (this.retired || this.disposed) {
			return { accepted: false, delivery: Promise.resolve(false) };
		}

		let prepared: unknown | undefined;
		try {
			prepared = this.options.prepareOutbound ? this.options.prepareOutbound(message) : message;
		} catch {
			return { accepted: false, delivery: Promise.resolve(false) };
		}
		if (prepared === undefined) {
			return { accepted: false, delivery: Promise.resolve(false) };
		}

		if (this.dispatcherReady && !this.outboundDrain && this.outboundQueue.length === 0) {
			return { accepted: true, delivery: this.deliver(prepared) };
		}

		let resolve!: (delivered: boolean) => void;
		const delivery = new Promise<boolean>(settle => { resolve = settle; });
		this.outboundQueue.push({ message: prepared, resolve });
		if (this.dispatcherReady) void this.drainOutbound();
		return { accepted: true, delivery };
	}

	private async drainOutbound(): Promise<void> {
		if (!this.dispatcherReady || this.retired) return;
		if (this.outboundDrain) return this.outboundDrain;

		const drain = (async () => {
			while (this.outboundQueue.length > 0) {
				const pending = this.outboundQueue.shift()!;
				if (this.retired) {
					pending.resolve(false);
					continue;
				}
				pending.resolve(await this.deliver(pending.message));
			}
		})();
		this.outboundDrain = drain;
		try {
			await drain;
		} finally {
			if (this.outboundDrain === drain) this.outboundDrain = undefined;
			if (this.dispatcherReady && !this.retired && this.outboundQueue.length > 0) {
				void this.drainOutbound();
			}
		}
	}

	private async deliver(message: unknown): Promise<boolean> {
		if (this.retired) return false;
		try {
			return await Promise.resolve(this.options.panel.webview.postMessage(message)) !== false;
		} catch {
			return false;
		}
	}
}
