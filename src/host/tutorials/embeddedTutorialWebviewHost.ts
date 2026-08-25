import * as vscode from 'vscode';
import { TutorialCatalogService } from './tutorialCatalogService';
import { TutorialSubscriptionService } from './tutorialSubscriptionService';
import {
	TutorialWebviewSession,
	isTutorialViewerMessage,
	type TutorialViewerMessage,
	type TutorialViewerOpenOptions,
} from './tutorialWebviewSession';

export interface EmbeddedTutorialServices {
	context: vscode.ExtensionContext;
	catalogService: TutorialCatalogService;
	subscriptionService: TutorialSubscriptionService;
}

type PendingHostWaiter = {
	resolve: (host: EmbeddedTutorialWebviewHost | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
};

type PendingShowAcknowledgement = {
	requestId: string;
	settle: (shown: boolean) => void;
};

const SHOW_ACK_TIMEOUT_MS = 10_000;
const SHOW_RETRY_DELAY_MS = 100;

function normalizeDocumentUri(documentUri: string | undefined): string {
	return String(documentUri ?? '').trim();
}

function dedupeUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
	const seen = new Set<string>();
	const result: vscode.Uri[] = [];
	for (const uri of uris) {
		const key = uri.toString();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(uri);
	}
	return result;
}

export class EmbeddedTutorialWebviewHost {
	private session: TutorialWebviewSession | undefined;
	private showSequence = 0;
	private pendingShowAcknowledgement: PendingShowAcknowledgement | undefined;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		readonly documentUri: string | undefined,
		private readonly messageTransport?: (message: unknown) => boolean | PromiseLike<boolean>,
	) {}

	get visible(): boolean {
		return !!this.panel.visible;
	}

	async show(services: EmbeddedTutorialServices, options: TutorialViewerOpenOptions): Promise<boolean> {
		this.pendingShowAcknowledgement?.settle(false);
		const sequence = ++this.showSequence;
		this.ensureTutorialResourceRoot(services.catalogService);
		if (!this.session) {
			this.session = new TutorialWebviewSession({
				context: services.context,
				catalogService: services.catalogService,
				subscriptionService: services.subscriptionService,
				webview: () => this.panel.webview,
				postMessage: message => this.postMessage(message),
				dismiss: () => this.hide(),
			}, options);
		} else {
			this.session.updateOptions(options);
		}
		const session = this.session;
		const isCurrent = () => sequence === this.showSequence && this.session === session;
		const shown = await this.waitForOverlayShown(sequence);
		if (!shown || !isCurrent()) {
			if (isCurrent()) await this.hideFailedShow(sequence, session);
			return false;
		}
		const snapshotDelivered = await session.postSnapshot({}, isCurrent);
		if (!snapshotDelivered || !isCurrent()) {
			if (isCurrent()) await this.hideFailedShow(sequence, session);
			return false;
		}
		return true;
	}

	handleMessage(message: unknown): boolean {
		if (message && typeof message === 'object'
			&& String((message as { type?: unknown }).type ?? '') === 'embeddedTutorialViewerShown') {
			const requestId = String((message as { requestId?: unknown }).requestId ?? '').trim();
			if (requestId && requestId === this.pendingShowAcknowledgement?.requestId) {
				this.pendingShowAcknowledgement.settle(true);
			}
			return true;
		}
		if (!isTutorialViewerMessage(message)) {
			return false;
		}
		if (this.pendingShowAcknowledgement) {
			return true;
		}
		void this.session?.enqueueMessage(message as TutorialViewerMessage);
		return true;
	}

	dispose(): void {
		this.showSequence++;
		this.pendingShowAcknowledgement?.settle(false);
		this.session?.dispose();
		this.session = undefined;
	}

	private hide(): void {
		this.showSequence++;
		this.pendingShowAcknowledgement?.settle(false);
		void this.postMessage({ type: 'hideEmbeddedTutorialViewer' }).catch(() => undefined);
		this.session?.dispose();
		this.session = undefined;
	}

	private waitForOverlayShown(sequence: number): Promise<boolean> {
		const requestId = `embedded-tutorial-${sequence}`;
		return new Promise(resolve => {
			let settled = false;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			const timeoutTimer = setTimeout(() => settle(false), SHOW_ACK_TIMEOUT_MS);
			const settle = (shown: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				if (retryTimer) clearTimeout(retryTimer);
				if (this.pendingShowAcknowledgement?.requestId === requestId) {
					this.pendingShowAcknowledgement = undefined;
				}
				resolve(shown);
			};
			const post = async () => {
				if (settled || sequence !== this.showSequence) {
					settle(false);
					return;
				}
				await this.postMessage({ type: 'showEmbeddedTutorialViewer', requestId }).catch(() => false);
				if (!settled && sequence === this.showSequence) {
					retryTimer = setTimeout(() => void post(), SHOW_RETRY_DELAY_MS);
				}
			};
			this.pendingShowAcknowledgement = { requestId, settle };
			void post();
		});
	}

	private async hideFailedShow(sequence: number, session: TutorialWebviewSession): Promise<void> {
		if (sequence !== this.showSequence || this.session !== session) return;
		this.showSequence++;
		this.pendingShowAcknowledgement?.settle(false);
		this.session = undefined;
		session.dispose();
		await this.postMessage({
			type: 'hideEmbeddedTutorialViewer', requestId: `embedded-tutorial-${sequence}`,
		}).catch(() => false);
	}

	private async postMessage(message: unknown): Promise<boolean> {
		if (this.messageTransport) {
			return await this.messageTransport(message) !== false;
		}
		return await this.panel.webview.postMessage(message) !== false;
	}

	private ensureTutorialResourceRoot(catalogService: TutorialCatalogService): void {
		const webview = this.panel.webview;
		const existingOptions = webview.options;
		const existingRoots = existingOptions.localResourceRoots ?? [];
		const cacheRoot = catalogService.getCacheRoot();
		if (existingRoots.some(root => root.toString() === cacheRoot.toString())) {
			return;
		}
		webview.options = {
			...existingOptions,
			localResourceRoots: dedupeUris([...existingRoots, cacheRoot]),
		};
	}
}

export class EmbeddedTutorialWebviewRegistry {
	private static readonly hosts = new Set<EmbeddedTutorialWebviewHost>();
	private static readonly waitersByDocumentUri = new Map<string, PendingHostWaiter[]>();

	static register(host: EmbeddedTutorialWebviewHost): vscode.Disposable {
		this.hosts.add(host);
		this.resolveWaiters(host);
		return {
			dispose: () => {
				host.dispose();
				this.hosts.delete(host);
			},
		};
	}

	static async showForDocument(
		documentUri: string | undefined,
		services: EmbeddedTutorialServices,
		options: TutorialViewerOpenOptions,
		timeoutMs = 15000,
	): Promise<boolean> {
		const host = this.findHost(documentUri) ?? await this.waitForHost(documentUri, timeoutMs);
		if (!host) {
			return false;
		}
		return host.show(services, options);
	}

	private static findHost(documentUri: string | undefined): EmbeddedTutorialWebviewHost | undefined {
		const normalized = normalizeDocumentUri(documentUri);
		const candidates = [...this.hosts].filter(host => !normalized || normalizeDocumentUri(host.documentUri) === normalized);
		return candidates.find(host => host.visible) ?? candidates[0];
	}

	private static waitForHost(documentUri: string | undefined, timeoutMs: number): Promise<EmbeddedTutorialWebviewHost | undefined> {
		const normalized = normalizeDocumentUri(documentUri);
		if (!normalized || timeoutMs <= 0) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				const waiters = this.waitersByDocumentUri.get(normalized) ?? [];
				this.waitersByDocumentUri.set(normalized, waiters.filter(waiter => waiter.resolve !== resolve));
				resolve(undefined);
			}, timeoutMs);
			const waiters = this.waitersByDocumentUri.get(normalized) ?? [];
			waiters.push({ resolve, timer });
			this.waitersByDocumentUri.set(normalized, waiters);
		});
	}

	private static resolveWaiters(host: EmbeddedTutorialWebviewHost): void {
		const normalized = normalizeDocumentUri(host.documentUri);
		if (!normalized) {
			return;
		}
		const waiters = this.waitersByDocumentUri.get(normalized);
		if (!waiters?.length) {
			return;
		}
		this.waitersByDocumentUri.delete(normalized);
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(host);
		}
	}
}