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
import { parseKustoResultAttachmentWebviewMessageFromEnvelope } from '../shared/kustoResultAttachmentProtocol';
import { captureRuntimeMessageEnvelope } from '../shared/runtimeMessageEnvelope';
import { parsePersistDocumentMessage } from '../shared/persistDocumentState';
import { parseSqlCopilotExecutionStartAck } from '../shared/copilotExecutionStart';

export const MAIN_WEBVIEW_DISPATCHER_READY_TYPE = 'mainWebviewDispatcherReady' as const;
export const MAIN_WEBVIEW_DISPATCHER_PROBE_TYPE = 'mainWebviewDispatcherProbe' as const;
export const MAIN_WEBVIEW_DISPATCHER_REVALIDATION_TIMEOUT_MS = 4_000;
export const MAIN_WEBVIEW_DISPATCHER_REVALIDATION_RETRY_MS = 250;
export const RETAINED_STARTUP_INITIALIZATION_TIMEOUT_MS = 2_000;

export type BoundedStartupSettlement<T> =
	| Readonly<{ settled: true; value: T }>
	| Readonly<{ settled: false }>;

export async function waitForRetainedStartupInitialization<T>(
	initialization: Promise<T>,
	timeoutMs = RETAINED_STARTUP_INITIALIZATION_TIMEOUT_MS,
): Promise<BoundedStartupSettlement<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			initialization.then(value => ({ settled: true as const, value })),
			new Promise<Readonly<{ settled: false }>>(resolve => {
				timer = setTimeout(() => resolve({ settled: false }), Math.max(0, timeoutMs));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

type GatewayTraceEvent = 'received' | 'queued' | 'flushQueued';

export interface MainWebviewStartupGatewayOptions<TInbound> {
	panel: vscode.WebviewPanel;
	admitInbound(input: unknown): TInbound | undefined;
	prepareOutbound?(message: unknown): unknown | undefined;
	allowReentrantInbound?(message: TInbound): boolean;
	allowRetiredInbound?(message: TInbound): boolean;
	trace?(event: GatewayTraceEvent, message: TInbound, queuedCount: number): void;
	dispatcherRevalidationTimeoutMs?: number;
	dispatcherRevalidationRetryMs?: number;
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
	if (type === 'copilotWriteQueryExecutionAck') {
		return parseSqlCopilotExecutionStartAck(input).ok;
	}
	if (type === 'persistDocument') {
		const parsed = parsePersistDocumentMessage(input);
		return parsed.ok && parsed.value.snapshotId !== undefined;
	}
	if (type === 'toolResponse') {
		const mutationAdmission = admitDevelopmentNoteMutationWebviewMessage(input);
		if (!mutationAdmission.recognized) return false;
		if (mutationAdmission.parsed.ok || mutationAdmission.requestId) return true;
		return safelyInspectProperty(input, 'requestId')?.kind === 'accessor';
	}
	switch (type) {
		case 'comparisonBoxEnsured':
		case 'documentReloadResult':
		case 'embeddedTutorialViewerShown':
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

type DispatcherReadySignal = Readonly<{ runtimeId?: string; probeId?: string }>;
function parseDispatcherReadyMessage(input: unknown): DispatcherReadySignal | undefined {
	const type = safelyInspectProperty(input, 'type');
	if (type?.kind !== 'data' || type.value !== MAIN_WEBVIEW_DISPATCHER_READY_TYPE) return undefined;
	const runtimeId = safelyInspectProperty(input, 'runtimeId');
	const probeId = safelyInspectProperty(input, 'probeId');
	if (runtimeId && (runtimeId.kind !== 'data' || typeof runtimeId.value !== 'string' || !runtimeId.value.trim())) return undefined;
	if (probeId && (probeId.kind !== 'data' || typeof probeId.value !== 'string' || !probeId.value.trim())) return undefined;
	return {
		...(runtimeId?.kind === 'data' ? { runtimeId: String(runtimeId.value).trim() } : {}),
		...(probeId?.kind === 'data' ? { probeId: String(probeId.value).trim() } : {}),
	};
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
	private dispatcherRuntimeId = '';
	private dispatcherRevalidationProbeId = '';
	private dispatcherRevalidationFailed = false;
	private dispatcherRevalidationTimer?: ReturnType<typeof setTimeout>;
	private dispatcherProbeRetryTimer?: ReturnType<typeof setTimeout>;
	private dispatcherProbeSequence = 0;
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

	beginDispatcherRevalidation(): void {
		if (this.retired || this.disposed
			|| (!this.dispatcherReady && !this.dispatcherRevalidationFailed)
			|| (this.dispatcherRevalidationProbeId && !this.dispatcherRevalidationFailed)) return;
		this.clearDispatcherRevalidationTimer();
		this.dispatcherReady = false;
		this.dispatcherRevalidationFailed = false;
		const probeId = `dispatcher_probe_${++this.dispatcherProbeSequence}_${Date.now()}`;
		this.dispatcherRevalidationProbeId = probeId;
		const timeoutMs = Math.max(0, this.options.dispatcherRevalidationTimeoutMs
			?? MAIN_WEBVIEW_DISPATCHER_REVALIDATION_TIMEOUT_MS);
		this.dispatcherRevalidationTimer = setTimeout(() => {
			this.failDispatcherRevalidation(probeId);
		}, timeoutMs);
		this.sendDispatcherProbe(probeId);
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
		this.clearDispatcherRevalidationTimer();
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
		if (envelope.value.type === 'selectKustoResult') {
			const parsed = parseKustoResultAttachmentWebviewMessageFromEnvelope(envelope.descriptorSnapshot);
			if (!parsed.ok) return;
			input = parsed.value;
		}
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
		if (envelope.value.type === 'persistDocument') {
			const parsed = parsePersistDocumentMessage(envelope.value);
			if (!parsed.ok) return;
			input = parsed.value;
		}
		if (envelope.value.type === 'copilotWriteQueryExecutionAck') {
			const parsed = parseSqlCopilotExecutionStartAck(envelope.value);
			if (!parsed.ok) return;
			input = parsed.value;
		}
		const dispatcherReady = parseDispatcherReadyMessage(input);
		if (dispatcherReady) return this.markDispatcherReady(dispatcherReady);

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

	private async markDispatcherReady(signal: DispatcherReadySignal): Promise<void> {
		if (this.retired) return;
		if (this.dispatcherRevalidationProbeId) {
			if (signal.probeId !== this.dispatcherRevalidationProbeId) return;
		} else if (this.dispatcherReady) {
			if (signal.runtimeId) this.dispatcherRuntimeId = signal.runtimeId;
			return;
		}
		this.clearDispatcherRevalidationTimer();
		this.dispatcherRevalidationProbeId = '';
		this.dispatcherRevalidationFailed = false;
		if (signal.runtimeId) this.dispatcherRuntimeId = signal.runtimeId;
		this.dispatcherReady = true;
		await this.drainOutbound();
	}

	private clearDispatcherRevalidationTimer(): void {
		if (this.dispatcherRevalidationTimer) clearTimeout(this.dispatcherRevalidationTimer);
		this.dispatcherRevalidationTimer = undefined;
		this.clearDispatcherProbeRetryTimer();
	}

	private clearDispatcherProbeRetryTimer(): void {
		if (this.dispatcherProbeRetryTimer) clearTimeout(this.dispatcherProbeRetryTimer);
		this.dispatcherProbeRetryTimer = undefined;
	}

	private sendDispatcherProbe(probeId: string): void {
		if (this.retired || this.disposed || this.dispatcherRevalidationProbeId !== probeId
			|| this.dispatcherRevalidationFailed) return;
		const retryMs = Math.max(1, this.options.dispatcherRevalidationRetryMs
			?? MAIN_WEBVIEW_DISPATCHER_REVALIDATION_RETRY_MS);
		this.clearDispatcherProbeRetryTimer();
		this.dispatcherProbeRetryTimer = setTimeout(() => this.sendDispatcherProbe(probeId), retryMs);
		void this.deliver({ type: MAIN_WEBVIEW_DISPATCHER_PROBE_TYPE, probeId });
	}

	private failDispatcherRevalidation(probeId: string): void {
		if (this.retired || this.dispatcherRevalidationProbeId !== probeId) return;
		this.clearDispatcherRevalidationTimer();
		this.dispatcherReady = false;
		this.dispatcherRevalidationFailed = true;
		for (const pending of this.outboundQueue.splice(0)) pending.resolve(false);
	}

	private enqueueOutbound(message: unknown): { accepted: boolean; delivery: Promise<boolean> } {
		if (this.retired || this.disposed || this.dispatcherRevalidationFailed) {
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
			while (this.dispatcherReady && this.outboundQueue.length > 0) {
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
