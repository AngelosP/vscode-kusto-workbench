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

	constructor(
		private readonly panel: vscode.WebviewPanel,
		readonly documentUri: string | undefined,
	) {}

	get visible(): boolean {
		return !!this.panel.visible;
	}

	async show(services: EmbeddedTutorialServices, options: TutorialViewerOpenOptions): Promise<void> {
		this.ensureTutorialResourceRoot(services.catalogService);
		if (!this.session) {
			this.session = new TutorialWebviewSession({
				context: services.context,
				catalogService: services.catalogService,
				subscriptionService: services.subscriptionService,
				webview: () => this.panel.webview,
				dismiss: () => this.hide(),
			}, options);
		} else {
			this.session.updateOptions(options);
		}
		this.postShowMessageWithRetries();
		await this.session.postSnapshot();
	}

	handleMessage(message: unknown): boolean {
		if (!isTutorialViewerMessage(message)) {
			return false;
		}
		void this.session?.enqueueMessage(message as TutorialViewerMessage);
		return true;
	}

	dispose(): void {
		this.session?.dispose();
		this.session = undefined;
	}

	private hide(): void {
		this.showSequence++;
		this.panel.webview.postMessage({ type: 'hideEmbeddedTutorialViewer' });
		this.dispose();
	}

	private postShowMessageWithRetries(): void {
		const sequence = ++this.showSequence;
		const post = () => {
			if (sequence !== this.showSequence) {
				return;
			}
			void this.panel.webview.postMessage({ type: 'showEmbeddedTutorialViewer' });
		};
		post();
		setTimeout(post, 100);
		setTimeout(post, 350);
	}

	private ensureTutorialResourceRoot(catalogService: TutorialCatalogService): void {
		const webview = this.panel.webview;
		const existingOptions = webview.options;
		const existingRoots = existingOptions.localResourceRoots ?? [];
		webview.options = {
			...existingOptions,
			localResourceRoots: dedupeUris([...existingRoots, catalogService.getCacheRoot()]),
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
		await host.show(services, options);
		return true;
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