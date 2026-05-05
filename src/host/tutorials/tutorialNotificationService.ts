import * as vscode from 'vscode';
import type { TutorialItem, TutorialNotificationCadence, TutorialNotificationChannel, TutorialViewerMode } from '../../shared/tutorials/tutorialCatalog';
import { TutorialCatalogService } from './tutorialCatalogService';
import { TutorialSubscriptionService } from './tutorialSubscriptionService';

const DIGEST_THROTTLE_MS = 6 * 60 * 60 * 1000;
const AUTOMATIC_CHECK_DATE_KEY = 'kusto.tutorials.lastAutomaticCheckDate.v1';
const PENDING_POPUPS_KEY = 'kusto.tutorials.pendingPopups.v1';
const CADENCE_INTERVAL_MS: Record<TutorialNotificationCadence, number> = {
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 30 * 24 * 60 * 60 * 1000,
};

interface PendingTutorialPopup {
	categoryId: string;
	title: string;
	count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePendingPopups(value: unknown): PendingTutorialPopup[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const popups: PendingTutorialPopup[] = [];
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.categoryId !== 'string' || typeof raw.title !== 'string' || typeof raw.count !== 'number') {
			continue;
		}
		if (!Number.isFinite(raw.count) || raw.count < 1) {
			continue;
		}
		popups.push({ categoryId: raw.categoryId, title: raw.title, count: Math.floor(raw.count) });
	}
	return popups;
}

export class TutorialNotificationService {
	private pendingPopups: PendingTutorialPopup[];
	private checking = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly catalogService: TutorialCatalogService,
		private readonly subscriptionService: TutorialSubscriptionService,
		private readonly openViewer: (categoryId?: string, preferredMode?: TutorialViewerMode) => Promise<void>,
	) {
		this.pendingPopups = normalizePendingPopups(this.context.globalState.get(PENDING_POPUPS_KEY));
	}

	async checkOnKustoFileOpen(): Promise<void> {
		if (!this.catalogService.getSettings().enabled) {
			await this.clearPendingPopups();
			return;
		}
		const pendingPopups = await this.takeDeliverablePendingPopups();
		if (pendingPopups.length === 0) {
			return;
		}
		const action = await vscode.window.showInformationMessage(
			this.pendingPopupMessage(pendingPopups),
			'Open Did you know?',
			'Dismiss',
		);
		const notifiedAt = new Date().toISOString();
		for (const pending of pendingPopups) {
			await this.subscriptionService.markCategoryNotified(pending.categoryId, notifiedAt);
		}
		if (action === 'Open Did you know?') {
			await this.openViewer(pendingPopups.length === 1 ? pendingPopups[0].categoryId : undefined, 'compact');
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
		if (this.hasCheckedToday()) {
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
			const digests: Array<{ categoryId: string; title: string; content: TutorialItem[]; channel: TutorialNotificationChannel }> = [];
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
			const deliverableDigests = digests.filter(digest => digest.channel === 'nextFileOpenPopup' || (digest.channel === 'vscodeNotification' && options.allowVsCodeNotification));
			if (deliverableDigests.length === 0) {
				return;
			}
			await this.subscriptionService.setLastDigestAt(new Date().toISOString());
			let pendingPopupsChanged = false;
			for (const digest of deliverableDigests) {
				if (digest.channel === 'nextFileOpenPopup') {
					this.queuePendingPopup({ categoryId: digest.categoryId, title: digest.title, count: digest.content.length });
					pendingPopupsChanged = true;
				} else if (digest.channel === 'vscodeNotification') {
					await this.showDigestNotification(digest.categoryId, digest.title, digest.content);
					await this.subscriptionService.markCategoryNotified(digest.categoryId);
				}
			}
			if (pendingPopupsChanged) {
				await this.persistPendingPopups();
			}
		} finally {
			this.checking = false;
		}
	}

	private async takeDeliverablePendingPopups(): Promise<PendingTutorialPopup[]> {
		if (this.pendingPopups.length === 0) {
			return [];
		}
		const deliverable = this.pendingPopups.filter(popup => this.canDeliverPendingPopup(popup));
		this.pendingPopups = [];
		await this.persistPendingPopups();
		return deliverable;
	}

	private canDeliverPendingPopup(popup: PendingTutorialPopup): boolean {
		const preference = this.subscriptionService.getStoredPreference(popup.categoryId);
		return preference?.subscribed === true && preference.muted !== true && preference.channel === 'nextFileOpenPopup';
	}

	private queuePendingPopup(popup: PendingTutorialPopup): void {
		this.pendingPopups = [
			...this.pendingPopups.filter(candidate => candidate.categoryId !== popup.categoryId),
			popup,
		];
	}

	private async clearPendingPopups(): Promise<void> {
		if (this.pendingPopups.length === 0) {
			return;
		}
		this.pendingPopups = [];
		await this.persistPendingPopups();
	}

	private async persistPendingPopups(): Promise<void> {
		await this.context.globalState.update(PENDING_POPUPS_KEY, this.pendingPopups.length > 0 ? this.pendingPopups : undefined);
	}

	private pendingPopupMessage(popups: PendingTutorialPopup[]): string {
		if (popups.length === 1) {
			const pending = popups[0];
			return `${pending.count} new ${pending.title} tutorial update${pending.count === 1 ? '' : 's'} available.`;
		}
		const count = popups.reduce((total, pending) => total + pending.count, 0);
		return `${count} new tutorial updates available across ${popups.length} categories.`;
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
