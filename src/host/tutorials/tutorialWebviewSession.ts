import * as vscode from 'vscode';
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
import { resolveTutorialsEnabledConfigurationTarget } from './tutorialViewerPanel';

export type TutorialViewerMessage =
	| { type: 'requestSnapshot' }
	| { type: 'refreshCatalog' }
	| { type: 'openTutorial'; tutorialId: string; markSeen?: boolean; markSeenTutorialIds?: string[] }
	| { type: 'setTutorialSeen'; tutorialId: string; seen: boolean }
	| { type: 'setPreferredMode'; mode: TutorialViewerMode }
	| { type: 'setCategorySubscription'; categoryId: string; subscribed: boolean }
	| { type: 'setCategorySubscriptions'; categoryIds: string[]; subscribed: boolean }
	| { type: 'setCategoryMuted'; categoryId: string; muted: boolean }
	| { type: 'setNotificationCadence'; categoryId: string; notificationCadence: TutorialNotificationCadence }
	| { type: 'setNotificationChannel'; categoryId: string; channel: TutorialNotificationChannel }
	| { type: 'setTutorialsEnabled'; enabled: boolean; dismissAfterUpdate?: boolean }
	| { type: 'dismiss' };

export interface TutorialViewerOpenOptions {
	selectedCategoryId?: string;
	selectedTutorialId?: string;
	preferredMode?: TutorialViewerMode;
}

interface TutorialWebviewSessionOptions {
	context: vscode.ExtensionContext;
	catalogService: TutorialCatalogService;
	subscriptionService: TutorialSubscriptionService;
	webview: () => vscode.Webview | undefined;
	dismiss: () => void | Promise<void>;
}

const tutorialViewerMessageTypes = new Set<string>([
	'requestSnapshot',
	'refreshCatalog',
	'openTutorial',
	'setTutorialSeen',
	'setPreferredMode',
	'setCategorySubscription',
	'setCategorySubscriptions',
	'setCategoryMuted',
	'setNotificationCadence',
	'setNotificationChannel',
	'setTutorialsEnabled',
	'dismiss',
]);

export function isTutorialViewerMessage(message: unknown): message is TutorialViewerMessage {
	return !!message
		&& typeof message === 'object'
		&& typeof (message as { type?: unknown }).type === 'string'
		&& tutorialViewerMessageTypes.has((message as { type: string }).type);
}

export class TutorialWebviewSession {
	private messageQueue = Promise.resolve();
	private snapshotRevision = 0;
	private selectedCategoryId: string | undefined;
	private selectedTutorialId: string | undefined;
	private preferredMode: TutorialViewerMode | undefined;
	private disposed = false;

	constructor(
		private readonly options: TutorialWebviewSessionOptions,
		openOptions: TutorialViewerOpenOptions = {},
	) {
		this.updateOptions(openOptions);
	}

	updateOptions(options: TutorialViewerOpenOptions = {}): void {
		this.selectedCategoryId = options.selectedCategoryId;
		this.selectedTutorialId = options.selectedTutorialId;
		this.preferredMode = options.preferredMode;
	}

	enqueueMessage(message: TutorialViewerMessage): Promise<void> {
		this.messageQueue = this.messageQueue.then(() => this.handleMessage(message));
		return this.messageQueue;
	}

	async postSnapshot(options: { forceRefresh?: boolean } = {}): Promise<void> {
		if (this.disposed) {
			return;
		}
		const revision = ++this.snapshotRevision;
		const resolved = await this.options.catalogService.getViewerCatalog(options);
		const catalog = await this.options.catalogService.getCatalog();
		const settings = this.options.catalogService.getSettings();
		const unseenTutorialIds = this.options.subscriptionService.getUnseenTutorialIds(catalog.catalog);
		const snapshot: TutorialViewerSnapshot = {
			catalog: {
				...resolved.catalog,
				content: resolved.catalog.content.map(tutorial => ({ ...tutorial, unseen: unseenTutorialIds.has(tutorial.id) })),
			},
			preferences: this.options.subscriptionService.getPreferences(catalog.catalog),
			status: resolved.status,
			tutorialsEnabled: settings.enabled,
			preferredMode: this.preferredMode ?? this.defaultPreferredMode(),
			selectedCategoryId: this.selectedCategoryId,
			selectedTutorialId: this.selectedTutorialId,
		};
		await this.postMessage({ type: 'snapshot', snapshot, revision });
	}

	dispose(): void {
		this.disposed = true;
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
					await this.postTutorial(message.tutorialId, { markSeen: message.markSeen === true, markSeenTutorialIds: message.markSeenTutorialIds });
					break;
				case 'setTutorialSeen':
					await this.setTutorialSeen(message.tutorialId, message.seen === true);
					break;
				case 'setPreferredMode':
					if (isTutorialViewerMode(message.mode)) {
						this.preferredMode = message.mode;
						if (message.mode === 'standard') {
							this.selectedCategoryId = undefined;
						}
						await this.postSnapshot();
					}
					break;
				case 'setCategorySubscription':
					await this.options.subscriptionService.setSubscription(message.categoryId, !!message.subscribed);
					await this.postSnapshot();
					break;
				case 'setCategorySubscriptions': {
					const resolved = await this.options.catalogService.getCatalog();
					const validCategoryIds = new Set(resolved.catalog.categories.map(category => category.id));
					const categoryIds = message.categoryIds.filter(categoryId => typeof categoryId === 'string' && validCategoryIds.has(categoryId));
					await this.options.subscriptionService.setSubscriptions(categoryIds, !!message.subscribed);
					await this.postSnapshot();
					break;
				}
				case 'setCategoryMuted':
					await this.options.subscriptionService.setMuted(message.categoryId, !!message.muted);
					await this.postSnapshot();
					break;
				case 'setNotificationChannel':
					if (isTutorialNotificationChannel(message.channel)) {
						await this.options.subscriptionService.setChannel(message.categoryId, message.channel);
						await this.postSnapshot();
					}
					break;
				case 'setNotificationCadence':
					if (isTutorialNotificationCadence(message.notificationCadence)) {
						await this.options.subscriptionService.setNotificationCadence(message.categoryId, message.notificationCadence);
						await this.postSnapshot();
					}
					break;
				case 'setTutorialsEnabled':
					await this.setTutorialsEnabled(!!message.enabled);
					if (message.dismissAfterUpdate) {
						await this.options.dismiss();
					} else {
						await this.postSnapshot();
					}
					break;
				case 'dismiss':
					await this.options.dismiss();
					break;
			}
		} catch (error) {
			await this.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async postTutorial(tutorialId: string, options: { markSeen?: boolean; markSeenTutorialIds?: string[] } = {}): Promise<void> {
		const webview = this.options.webview();
		if (!webview || this.disposed) {
			return;
		}
		const content = await this.options.catalogService.getTutorialContent(tutorialId, webview);
		const resolved = await this.options.catalogService.getCatalog();
		const tutorial = resolved.catalog.content.find(candidate => candidate.id === tutorialId);
		if (tutorial) {
			const effectiveMode = this.preferredMode ?? this.defaultPreferredMode();
			if (effectiveMode === 'compact' || effectiveMode === 'focused' || this.selectedCategoryId !== undefined) {
				this.selectedCategoryId = tutorial.categoryId;
			}
			this.selectedTutorialId = tutorial.id;
			const markSeenTutorialIds = new Set((options.markSeenTutorialIds ?? []).filter(candidate => typeof candidate === 'string'));
			if (options.markSeen) {
				markSeenTutorialIds.add(tutorial.id);
			}
			for (const markSeenTutorialId of markSeenTutorialIds) {
				const tutorialToMarkSeen = resolved.catalog.content.find(candidate => candidate.id === markSeenTutorialId);
				if (tutorialToMarkSeen) {
					await this.options.subscriptionService.markTutorialSeen(tutorialToMarkSeen.categoryId, tutorialToMarkSeen.updateToken);
				}
			}
		}
		await this.postMessage({ type: 'tutorialContent', content });
		await this.postSnapshot();
	}

	private async setTutorialSeen(tutorialId: string, seen: boolean): Promise<void> {
		const resolved = await this.options.catalogService.getCatalog();
		const tutorial = resolved.catalog.content.find(candidate => candidate.id === tutorialId);
		if (tutorial) {
			await this.options.subscriptionService.setTutorialSeen(tutorial.categoryId, tutorial.updateToken, seen);
		}
		await this.postSnapshot();
	}

	private async setTutorialsEnabled(enabled: boolean): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const configuration = workspaceFolder
			? vscode.workspace.getConfiguration('kustoWorkbench', workspaceFolder.uri)
			: vscode.workspace.getConfiguration('kustoWorkbench');
		const target = resolveTutorialsEnabledConfigurationTarget(configuration.inspect<boolean>('didYouKnow.enabled'), workspaceFolder !== undefined);
		await configuration.update('didYouKnow.enabled', enabled, target);
	}

	private async postMessage(message: unknown): Promise<void> {
		const webview = this.options.webview();
		if (!webview || this.disposed) {
			return;
		}
		await webview.postMessage(message);
	}

	private defaultPreferredMode(): TutorialViewerMode {
		return this.options.subscriptionService.getSubscribedCategoryIds().length > 0 ? 'compact' : 'standard';
	}
}