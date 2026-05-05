import type * as vscode from 'vscode';
import type { TutorialCatalogService } from './tutorialCatalogService';
import { AUTOMATIC_CHECK_DATE_KEY, PENDING_POPUPS_KEY, type PendingTutorialPopup } from './tutorialNotificationService';
import { SUBSCRIPTION_STATE_KEY } from './tutorialSubscriptionService';

const LEGACY_PENDING_POPUP_KEY = 'kusto.tutorials.pendingPopup.v1';

export interface ResetDidYouKnowDevelopmentStateResult {
	categoryCount: number;
	contentCount: number;
	pendingPopupCount: number;
	source: string;
}

export async function resetDidYouKnowDevelopmentState(
	context: vscode.ExtensionContext,
	catalogService: TutorialCatalogService,
): Promise<ResetDidYouKnowDevelopmentStateResult> {
	const resolved = await catalogService.getCatalog({ forceRefresh: true });
	const contentCountByCategory = new Map<string, number>();
	for (const item of resolved.catalog.content) {
		contentCountByCategory.set(item.categoryId, (contentCountByCategory.get(item.categoryId) ?? 0) + 1);
	}

	const categories = resolved.catalog.categories.map(category => ({
		categoryId: category.id,
		subscribed: true,
		channel: 'nextFileOpenPopup' as const,
		previousChannel: 'nextFileOpenPopup' as const,
		notificationCadence: 'daily' as const,
		muted: false,
		seenUpdateTokens: [],
	}));
	const pendingPopups: PendingTutorialPopup[] = resolved.catalog.categories
		.map(category => ({
			categoryId: category.id,
			title: category.title,
			count: contentCountByCategory.get(category.id) ?? 0,
		}))
		.filter(popup => popup.count > 0);

	await context.globalState.update(SUBSCRIPTION_STATE_KEY, { categories });
	await context.globalState.update(PENDING_POPUPS_KEY, pendingPopups.length > 0 ? pendingPopups : undefined);
	await context.globalState.update(AUTOMATIC_CHECK_DATE_KEY, undefined);
	await context.globalState.update(LEGACY_PENDING_POPUP_KEY, undefined);

	return {
		categoryCount: categories.length,
		contentCount: resolved.catalog.content.length,
		pendingPopupCount: pendingPopups.length,
		source: resolved.source,
	};
}
