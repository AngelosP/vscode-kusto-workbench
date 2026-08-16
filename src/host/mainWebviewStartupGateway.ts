import type * as vscode from 'vscode';
import {
	admitArtifactCsvSaveWebviewMessage,
	admitArtifactCsvSaveWebviewMessageFromEnvelope,
} from '../shared/artifactCsvSaveProtocol';
import {
	admitKustoPublicationHostMessage,
	admitKustoPublicationWebviewMessage,
	admitKustoPublicationWebviewMessageFromEnvelope,
} from '../shared/kustoPublicationProtocol';
import { admitDevelopmentNoteMutationWebviewMessage } from '../shared/developmentNoteMutationProtocol';
import {
	admitToolStateSnapshotHostMessage,
	admitToolStateSnapshotWebviewMessage,
	admitToolStateSnapshotWebviewMessageFromEnvelope,
} from '../shared/toolStateSnapshotProtocol';
import {
	admitKustoExecutionStartHostMessage,
	admitKustoExecutionStartWebviewMessage,
	admitKustoExecutionStartWebviewMessageFromEnvelope,
} from '../shared/kustoExecutionStartProtocol';
import {
	admitPowerBiPublishHostMessage,
	admitPowerBiPublishWebviewMessage,
	admitPowerBiPublishWebviewMessageFromEnvelope,
} from '../shared/powerBiPublishProtocol';
import { captureRuntimeMessageEnvelope } from '../shared/runtimeMessageEnvelope';

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

type SafePropertyInspection =
	| Readonly<{ kind: 'data'; value: unknown }>
	| Readonly<{ kind: 'accessor' }>;

function hasCorrelationId(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function safelyInspectProperty(input: unknown, key: string): SafePropertyInspection | undefined {
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
	try {
		if (typeof input === 'function' || Array.isArray(input)) return undefined;
		let owner = input as object | null;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) return undefined;
			seen.add(owner);
			const descriptor = Object.getOwnPropertyDescriptor(owner, key);
			if (descriptor) {
				return Object.prototype.hasOwnProperty.call(descriptor, 'value')
					? { kind: 'data', value: descriptor.value }
					: { kind: 'accessor' };
			}
			owner = Object.getPrototypeOf(owner);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function hasDescriptorCorrelationId(input: unknown, key: string): boolean {
	const inspected = safelyInspectProperty(input, key);
	return inspected?.kind === 'data' && hasCorrelationId(inspected.value);
}

function hasSafeIntegerProperty(input: unknown, key: string): boolean {
	const inspected = safelyInspectProperty(input, key);
	return inspected?.kind === 'data' && Number.isSafeInteger(inspected.value);
}

function hasAllowedStringProperty(input: unknown, key: string, allowed: readonly string[]): boolean {
	const inspected = safelyInspectProperty(input, key);
	return inspected?.kind === 'data'
		&& typeof inspected.value === 'string'
		&& allowed.includes(inspected.value);
}


export function isMainWebviewCorrelatedReply(input: unknown): boolean {
	const publicationAdmission = admitKustoPublicationWebviewMessage(input);
	if (publicationAdmission.recognized) return publicationAdmission.parsed.ok;
	const artifactCsvSaveAdmission = admitArtifactCsvSaveWebviewMessage(input);
	if (artifactCsvSaveAdmission.recognized) {
		return artifactCsvSaveAdmission.parsed.ok
			&& artifactCsvSaveAdmission.parsed.value.type === 'artifactCsvSaveData';
	}
	const toolStateAdmission = admitToolStateSnapshotWebviewMessage(input);
	if (toolStateAdmission.recognized) return toolStateAdmission.parsed.ok;
	const executionStartAdmission = admitKustoExecutionStartWebviewMessage(input);
	if (executionStartAdmission.recognized) return executionStartAdmission.parsed.ok;
	const powerBiPublishAdmission = admitPowerBiPublishWebviewMessage(input);
	if (powerBiPublishAdmission.recognized) return powerBiPublishAdmission.parsed.ok;
	const typeInspection = safelyInspectProperty(input, 'type');
	if (typeInspection?.kind !== 'data' || typeof typeInspection.value !== 'string') return false;
	const type = typeInspection.value;
	if (type === 'toolResponse') {
		const mutationAdmission = admitDevelopmentNoteMutationWebviewMessage(input);
		if (!mutationAdmission.recognized) return false;
		if (mutationAdmission.parsed.ok || mutationAdmission.requestId) return true;
		return safelyInspectProperty(input, 'requestId')?.kind === 'accessor';
	}
	switch (type) {
		case 'comparisonBoxEnsured':
		case 'documentReloadResult':
		case 'markdownDocumentCommandBarrierResult':
		case 'toolExecutionStarted':
			return hasDescriptorCorrelationId(input, 'requestId');
		case 'sqlComparisonAdmissionAck':
			return hasDescriptorCorrelationId(input, 'requestId')
				&& hasDescriptorCorrelationId(input, 'sourceBoxId')
				&& hasDescriptorCorrelationId(input, 'comparisonBoxId')
				&& hasAllowedStringProperty(
					input,
					'phase',
					['staged', 'committed', 'finalized', 'completed', 'rolledBack'],
				);
		default:
			return false;
	}
}

function isDispatcherReadyMessage(input: unknown): boolean {
	const type = safelyInspectProperty(input, 'type');
	return type?.kind === 'data' && type.value === MAIN_WEBVIEW_DISPATCHER_READY_TYPE;
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
		const envelope = captureRuntimeMessageEnvelope(input);
		if (!envelope.ok) return;
		input = envelope.value;
		const publicationAdmission = admitKustoPublicationWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (publicationAdmission.recognized) {
			if (!publicationAdmission.parsed.ok) return;
			input = publicationAdmission.parsed.value;
		}
		const artifactCsvSaveAdmission = admitArtifactCsvSaveWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (artifactCsvSaveAdmission.recognized) {
			if (!artifactCsvSaveAdmission.parsed.ok) return;
			input = artifactCsvSaveAdmission.parsed.value;
		}
		const toolStateAdmission = admitToolStateSnapshotWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (toolStateAdmission.recognized) {
			if (!toolStateAdmission.parsed.ok) return;
			input = toolStateAdmission.parsed.value;
		}
		const executionStartAdmission = admitKustoExecutionStartWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (executionStartAdmission.recognized) {
			if (!executionStartAdmission.parsed.ok) return;
			input = executionStartAdmission.parsed.value;
		}
		const powerBiPublishAdmission = admitPowerBiPublishWebviewMessageFromEnvelope(
			envelope.descriptorSnapshot,
		);
		if (powerBiPublishAdmission.recognized) {
			if (!powerBiPublishAdmission.parsed.ok) return;
			input = powerBiPublishAdmission.parsed.value;
		}
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
		const executionStartAdmission = admitKustoExecutionStartHostMessage(message);
		if (executionStartAdmission.recognized) {
			if (!executionStartAdmission.parsed.ok) {
				return { accepted: false, delivery: Promise.resolve(false) };
			}
			message = executionStartAdmission.parsed.value;
		}
		const toolStateAdmission = admitToolStateSnapshotHostMessage(message);
		if (toolStateAdmission.recognized) {
			if (!toolStateAdmission.parsed.ok) {
				return { accepted: false, delivery: Promise.resolve(false) };
			}
			message = toolStateAdmission.parsed.value;
		}
		const publicationAdmission = admitKustoPublicationHostMessage(message);
		if (publicationAdmission.recognized) {
			if (!publicationAdmission.parsed.ok) {
				return { accepted: false, delivery: Promise.resolve(false) };
			}
			message = publicationAdmission.parsed.value;
		}
		const powerBiPublishAdmission = admitPowerBiPublishHostMessage(message);
		if (powerBiPublishAdmission.recognized) {
			if (!powerBiPublishAdmission.parsed.ok) {
				return { accepted: false, delivery: Promise.resolve(false) };
			}
			message = powerBiPublishAdmission.parsed.value;
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
