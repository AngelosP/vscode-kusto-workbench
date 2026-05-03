import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import {
	isTutorialNotificationCadence,
	isTutorialNotificationChannel,
	isTutorialViewerMode,
	type TutorialNotificationCadence,
	type TutorialNotificationChannel,
	type TutorialViewerMode,
	type TutorialViewerSnapshot,
} from '../../shared/tutorials/tutorialCatalog';
import { TutorialCatalogService } from './tutorialCatalogService';
import { TutorialSubscriptionService } from './tutorialSubscriptionService';

type TutorialViewerMessage =
	| { type: 'requestSnapshot' }
	| { type: 'refreshCatalog' }
	| { type: 'openTutorial'; tutorialId: string; markSeen?: boolean }
	| { type: 'setPreferredMode'; mode: TutorialViewerMode }
	| { type: 'setCategorySubscription'; categoryId: string; subscribed: boolean }
	| { type: 'setCategorySubscriptions'; categoryIds: string[]; subscribed: boolean }
	| { type: 'setNotificationCadence'; categoryId: string; notificationCadence: TutorialNotificationCadence }
	| { type: 'setNotificationChannel'; categoryId: string; channel: TutorialNotificationChannel }
	| { type: 'setTutorialsEnabled'; enabled: boolean; dismissAfterUpdate?: boolean }
	| { type: 'dismiss' };

interface TutorialViewerOpenOptions {
	selectedCategoryId?: string;
	selectedTutorialId?: string;
	preferredMode?: TutorialViewerMode;
}

export class TutorialViewerPanel {
	private static current: TutorialViewerPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private messageQueue = Promise.resolve();
	private snapshotRevision = 0;
	private selectedCategoryId: string | undefined;
	private selectedTutorialId: string | undefined;
	private preferredMode: TutorialViewerMode | undefined;
	private disposed = false;

	static open(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		catalogService: TutorialCatalogService,
		subscriptionService: TutorialSubscriptionService,
		options: TutorialViewerOpenOptions = {},
	): TutorialViewerPanel {
		if (TutorialViewerPanel.current) {
			TutorialViewerPanel.current.selectedCategoryId = options.selectedCategoryId;
			TutorialViewerPanel.current.selectedTutorialId = options.selectedTutorialId;
			TutorialViewerPanel.current.preferredMode = options.preferredMode;
			TutorialViewerPanel.current.panel.reveal(vscode.ViewColumn.One);
			void TutorialViewerPanel.current.postSnapshot();
			return TutorialViewerPanel.current;
		}
		const panel = vscode.window.createWebviewPanel(
			'kustoTutorialViewer',
			'Did you know?',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri, catalogService.getCacheRoot()],
			},
		);
		TutorialViewerPanel.current = new TutorialViewerPanel(panel, context, extensionUri, catalogService, subscriptionService, options);
		return TutorialViewerPanel.current;
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly catalogService: TutorialCatalogService,
		private readonly subscriptionService: TutorialSubscriptionService,
		options: TutorialViewerOpenOptions,
	) {
		this.selectedCategoryId = options.selectedCategoryId;
		this.selectedTutorialId = options.selectedTutorialId;
		this.preferredMode = options.preferredMode;
		this.panel.webview.html = this.buildHtml(this.panel.webview);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(message => this.enqueueMessage(message), null, this.disposables);
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('kustoWorkbench.didYouKnow.enabled')) {
				void this.postSnapshot();
			}
		}, null, this.disposables);
	}

	private enqueueMessage(message: TutorialViewerMessage): void {
		this.messageQueue = this.messageQueue.then(() => this.handleMessage(message));
	}

	private async handleMessage(message: TutorialViewerMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'requestSnapshot':
					await this.postSnapshot();
					break;
				case 'refreshCatalog':
					await this.postSnapshot({ forceRefresh: true });
					break;
				case 'openTutorial':
					await this.postTutorial(message.tutorialId, { markSeen: message.markSeen === true });
					break;
				case 'setPreferredMode':
					if (isTutorialViewerMode(message.mode)) {
						this.preferredMode = message.mode;
						await this.postSnapshot();
					}
					break;
				case 'setCategorySubscription':
					await this.subscriptionService.setSubscription(message.categoryId, !!message.subscribed);
					await this.postSnapshot();
					break;
				case 'setCategorySubscriptions': {
					const resolved = await this.catalogService.getCatalog();
					const validCategoryIds = new Set(resolved.catalog.categories.map(category => category.id));
					const categoryIds = message.categoryIds.filter(categoryId => typeof categoryId === 'string' && validCategoryIds.has(categoryId));
					await this.subscriptionService.setSubscriptions(categoryIds, !!message.subscribed);
					await this.postSnapshot();
					break;
				}
				case 'setNotificationChannel':
					if (isTutorialNotificationChannel(message.channel)) {
						await this.subscriptionService.setChannel(message.categoryId, message.channel);
						await this.postSnapshot();
					}
					break;
				case 'setNotificationCadence':
					if (isTutorialNotificationCadence(message.notificationCadence)) {
						await this.subscriptionService.setNotificationCadence(message.categoryId, message.notificationCadence);
						await this.postSnapshot();
					}
					break;
				case 'setTutorialsEnabled':
					await this.setTutorialsEnabled(!!message.enabled);
					if (message.dismissAfterUpdate) {
						this.panel.dispose();
					} else {
						await this.postSnapshot();
					}
					break;
				case 'dismiss':
					this.panel.dispose();
					break;
			}
		} catch (error) {
			await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async postSnapshot(options: { forceRefresh?: boolean } = {}): Promise<void> {
		if (this.disposed) {
			return;
		}
		const revision = ++this.snapshotRevision;
		const resolved = await this.catalogService.getViewerCatalog(options);
		const catalog = await this.catalogService.getCatalog();
		const settings = this.catalogService.getSettings();
		const unseenTutorialIds = this.subscriptionService.getUnseenTutorialIds(catalog.catalog);
		const snapshot: TutorialViewerSnapshot = {
			catalog: {
				...resolved.catalog,
				content: resolved.catalog.content.map(tutorial => ({ ...tutorial, unseen: unseenTutorialIds.has(tutorial.id) })),
			},
			preferences: this.subscriptionService.getPreferences(catalog.catalog),
			status: resolved.status,
			tutorialsEnabled: settings.enabled,
			preferredMode: this.preferredMode ?? this.defaultPreferredMode(),
			selectedCategoryId: this.selectedCategoryId,
			selectedTutorialId: this.selectedTutorialId,
		};
		await this.panel.webview.postMessage({ type: 'snapshot', snapshot, revision });
	}

	private async postTutorial(tutorialId: string, options: { markSeen?: boolean } = {}): Promise<void> {
		const content = await this.catalogService.getTutorialContent(tutorialId, this.panel.webview);
		const resolved = await this.catalogService.getCatalog();
		const tutorial = resolved.catalog.content.find(candidate => candidate.id === tutorialId);
		if (tutorial) {
			this.selectedCategoryId = tutorial.categoryId;
			this.selectedTutorialId = tutorial.id;
			if (options.markSeen) {
				await this.subscriptionService.markTutorialSeen(tutorial.categoryId, tutorial.updateToken);
			}
		}
		await this.panel.webview.postMessage({ type: 'tutorialContent', content });
		await this.postSnapshot();
	}

	private async setTutorialsEnabled(enabled: boolean): Promise<void> {
		await vscode.workspace.getConfiguration('kustoWorkbench').update('didYouKnow.enabled', enabled, vscode.ConfigurationTarget.Global);
	}

	private buildHtml(webview: vscode.Webview): string {
		const templateUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'tutorial-viewer.html');
		let html = '';
		try {
			html = new TextDecoder().decode(fs.readFileSync(templateUri.fsPath));
		} catch (error) {
			return `<html><body>Failed to load tutorial viewer: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}</body></html>`;
		}
		const nonce = randomBytes(16).toString('base64');
		const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'tutorial-viewer.bundle.js'));
		const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'vendor', 'marked.min.js'));
		const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'vendor', 'purify.min.js'));
		const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf'));
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return html
			.replace(/{{csp}}/g, csp)
			.replace(/{{nonce}}/g, nonce)
			.replace(/{{tutorialViewerBundleUri}}/g, String(bundleUri))
			.replace(/{{markedUri}}/g, String(markedUri))
			.replace(/{{purifyUri}}/g, String(purifyUri))
			.replace(/{{codiconFontUri}}/g, String(codiconsFontUri));
	}

	private defaultPreferredMode(): TutorialViewerMode {
		return this.subscriptionService.getSubscribedCategoryIds().length > 0 ? 'compact' : 'standard';
	}

	private escapeHtml(value: string): string {
		return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
	}

	private dispose(): void {
		this.disposed = true;
		TutorialViewerPanel.current = undefined;
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
