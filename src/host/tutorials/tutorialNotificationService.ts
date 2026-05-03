import * as vscode from 'vscode';
import type { TutorialItem, TutorialNotificationCadence, TutorialViewerMode } from '../../shared/tutorials/tutorialCatalog';
import { TutorialCatalogService } from './tutorialCatalogService';
import { TutorialSubscriptionService } from './tutorialSubscriptionService';

const DIGEST_THROTTLE_MS = 6 * 60 * 60 * 1000;
const AUTOMATIC_CHECK_DATE_KEY = 'kusto.tutorials.lastAutomaticCheckDate.v1';
const CADENCE_INTERVAL_MS: Record<TutorialNotificationCadence, number> = {
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 30 * 24 * 60 * 60 * 1000,
};

export class TutorialNotificationService {
	private pendingPopup: { categoryId: string; title: string; count: number } | null = null;
	private checking = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly catalogService: TutorialCatalogService,
		private readonly subscriptionService: TutorialSubscriptionService,
		private readonly openViewer: (categoryId?: string, preferredMode?: TutorialViewerMode) => Promise<void>,
	) { }

	async checkOnKustoFileOpen(): Promise<void> {
		if (!this.catalogService.getSettings().enabled) {
			this.pendingPopup = null;
			return;
		}
		if (this.subscriptionService.getSubscribedCategoryIds().length === 0) {
			return;
		}
		if (this.pendingPopup) {
			const pending = this.pendingPopup;
			this.pendingPopup = null;
			const action = await vscode.window.showInformationMessage(
				`${pending.count} new ${pending.title} tutorial update${pending.count === 1 ? '' : 's'} available.`,
				'Open Did you know?',
				'Dismiss',
			);
			if (action === 'Open Did you know?') {
				await this.openViewer(pending.categoryId, 'compact');
			}
		}
	}

	async checkOnActivation(): Promise<void> {
		const settings = this.catalogService.getSettings();
		if (!settings.enabled) {
			return;
		}
		if (this.subscriptionService.getSubscribedCategoryIds().length === 0) {
			return;
		}
		if (!settings.enableUpdateChecks || this.hasCheckedToday()) {
			return;
		}
		try {
			await this.checkForUpdates({ allowVsCodeNotification: true, forceRefresh: true, requireRemote: true });
		} finally {
			await this.context.globalState.update(AUTOMATIC_CHECK_DATE_KEY, this.todayKey());
		}
	}

	private async checkForUpdates(options: { allowVsCodeNotification: boolean; forceRefresh?: boolean; requireRemote?: boolean }): Promise<void> {
		if (!this.catalogService.getSettings().enabled) {
			return;
		}
		if (this.checking) {
			return;
		}
		const lastDigestAt = this.subscriptionService.getLastDigestAt();
		if (lastDigestAt && Date.now() - Date.parse(lastDigestAt) < DIGEST_THROTTLE_MS) {
			return;
		}

		this.checking = true;
		try {
			const resolved = await this.catalogService.getCatalog({ forceRefresh: options.forceRefresh });
			if (options.requireRemote && resolved.source !== 'remote') {
				return;
			}
			if (resolved.source === 'unavailable') {
				return;
			}
			const preferences = this.subscriptionService.getPreferences(resolved.catalog);
			const digests: Array<{ categoryId: string; title: string; content: TutorialItem[]; channel: string }> = [];
			for (const preference of preferences) {
				if (!preference.subscribed || preference.channel === 'off') {
					continue;
				}
				const stored = this.subscriptionService.getStoredPreference(preference.categoryId);
				if (!this.shouldNotifyForCadence(stored?.lastNotifiedAt, preference.notificationCadence)) {
					continue;
				}
				const seen = new Set(stored?.seenUpdateTokens ?? []);
				const unseen = resolved.catalog.content.filter(tutorial => tutorial.categoryId === preference.categoryId && !seen.has(tutorial.updateToken));
				if (unseen.length === 0) {
					continue;
				}
				const category = resolved.catalog.categories.find(candidate => candidate.id === preference.categoryId);
				digests.push({ categoryId: preference.categoryId, title: category?.title ?? preference.categoryId, content: unseen, channel: preference.channel });
			}
			if (digests.length === 0) {
				return;
			}
			await this.subscriptionService.setLastDigestAt(new Date().toISOString());
			for (const digest of digests) {
				await this.subscriptionService.markCategoryNotified(digest.categoryId);
				if (digest.channel === 'nextFileOpenPopup') {
					this.pendingPopup = { categoryId: digest.categoryId, title: digest.title, count: digest.content.length };
				} else if (digest.channel === 'vscodeNotification' && options.allowVsCodeNotification) {
					await this.showDigestNotification(digest.categoryId, digest.title, digest.content);
				}
			}
		} finally {
			this.checking = false;
		}
	}

	private async showDigestNotification(categoryId: string, title: string, content: TutorialItem[]): Promise<void> {
		const action = await vscode.window.showInformationMessage(
			`${content.length} new ${title} tutorial update${content.length === 1 ? '' : 's'} available.`,
			'Open Did you know?',
		);
		if (action === 'Open Did you know?') {
			await this.openViewer(categoryId, 'compact');
		}
	}

	private shouldNotifyForCadence(lastNotifiedAt: string | undefined, cadence: TutorialNotificationCadence): boolean {
		if (!lastNotifiedAt) {
			return true;
		}
		const lastNotified = Date.parse(lastNotifiedAt);
		if (!Number.isFinite(lastNotified)) {
			return true;
		}
		return Date.now() - lastNotified >= CADENCE_INTERVAL_MS[cadence];
	}

	private hasCheckedToday(): boolean {
		return this.context.globalState.get<string>(AUTOMATIC_CHECK_DATE_KEY) === this.todayKey();
	}

	private todayKey(): string {
		const now = new Date();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		return `${now.getFullYear()}-${month}-${day}`;
	}
}

export function isKustoTutorialTriggerDocument(doc: vscode.TextDocument): boolean {
	if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-userdata') {
		return false;
	}
	return /\.(kql|csl|kqlx|mdx|sqlx)$/i.test(doc.uri.fsPath || doc.uri.path);
}
