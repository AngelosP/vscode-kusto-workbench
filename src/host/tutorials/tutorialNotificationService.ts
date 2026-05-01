import * as vscode from 'vscode';
import type { TutorialCatalog, TutorialItem } from '../../shared/tutorials/tutorialCatalog';
import { TutorialCatalogService } from './tutorialCatalogService';
import { TutorialSubscriptionService } from './tutorialSubscriptionService';

const DIGEST_THROTTLE_MS = 6 * 60 * 60 * 1000;

export class TutorialNotificationService {
	private pendingPopup: { categoryId: string; title: string; count: number } | null = null;
	private checking = false;

	constructor(
		private readonly catalogService: TutorialCatalogService,
		private readonly subscriptionService: TutorialSubscriptionService,
		private readonly openViewer: (categoryId?: string) => Promise<void>,
	) { }

	async checkOnKustoFileOpen(): Promise<void> {
		if (this.subscriptionService.getSubscribedCategoryIds().length === 0) {
			return;
		}
		await this.checkForUpdates({ allowVsCodeNotification: false });
		if (this.pendingPopup) {
			const pending = this.pendingPopup;
			this.pendingPopup = null;
			const action = await vscode.window.showInformationMessage(
				`${pending.count} new ${pending.title} tutorial update${pending.count === 1 ? '' : 's'} available.`,
				'Open Tutorials',
				'Dismiss',
			);
			if (action === 'Open Tutorials') {
				await this.openViewer(pending.categoryId);
			}
		}
	}

	async checkOnViewerOpen(): Promise<void> {
		if (this.subscriptionService.getSubscribedCategoryIds().length === 0) {
			return;
		}
		await this.checkForUpdates({ allowVsCodeNotification: true });
	}

	private async checkForUpdates(options: { allowVsCodeNotification: boolean }): Promise<void> {
		if (this.checking) {
			return;
		}
		const lastDigestAt = this.subscriptionService.getLastDigestAt();
		if (lastDigestAt && Date.now() - Date.parse(lastDigestAt) < DIGEST_THROTTLE_MS) {
			return;
		}

		this.checking = true;
		try {
			const resolved = await this.catalogService.getCatalog();
			const preferences = this.subscriptionService.getPreferences(resolved.catalog);
			const digests: Array<{ categoryId: string; title: string; tutorials: TutorialItem[]; channel: string }> = [];
			for (const preference of preferences) {
				if (!preference.subscribed || preference.channel === 'off') {
					continue;
				}
				const stored = this.subscriptionService.getStoredPreference(preference.categoryId);
				const seen = new Set(stored?.seenUpdateTokens ?? []);
				const unseen = resolved.catalog.tutorials.filter(tutorial => tutorial.categoryId === preference.categoryId && !seen.has(tutorial.updateToken));
				if (unseen.length === 0) {
					continue;
				}
				const category = resolved.catalog.categories.find(candidate => candidate.id === preference.categoryId);
				digests.push({ categoryId: preference.categoryId, title: category?.title ?? preference.categoryId, tutorials: unseen, channel: preference.channel });
			}
			if (digests.length === 0) {
				return;
			}
			await this.subscriptionService.setLastDigestAt(new Date().toISOString());
			for (const digest of digests) {
				await this.subscriptionService.markCategorySeen(resolved.catalog, digest.categoryId);
				if (digest.channel === 'nextFileOpenPopup') {
					this.pendingPopup = { categoryId: digest.categoryId, title: digest.title, count: digest.tutorials.length };
				} else if (digest.channel === 'vscodeNotification' && options.allowVsCodeNotification) {
					await this.showDigestNotification(resolved.catalog, digest.categoryId, digest.title, digest.tutorials);
				}
			}
		} finally {
			this.checking = false;
		}
	}

	private async showDigestNotification(catalog: TutorialCatalog, categoryId: string, title: string, tutorials: TutorialItem[]): Promise<void> {
		const action = await vscode.window.showInformationMessage(
			`${tutorials.length} new ${title} tutorial update${tutorials.length === 1 ? '' : 's'} available.`,
			'Open Tutorials',
			'Mark Seen',
		);
		if (action === 'Open Tutorials') {
			await this.openViewer(categoryId);
		} else if (action === 'Mark Seen') {
			await this.subscriptionService.markCategorySeen(catalog, categoryId);
		}
	}
}

export function isKustoTutorialTriggerDocument(doc: vscode.TextDocument): boolean {
	if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-userdata') {
		return false;
	}
	return /\.(kql|csl|kqlx|mdx|sqlx)$/i.test(doc.uri.fsPath || doc.uri.path);
}
