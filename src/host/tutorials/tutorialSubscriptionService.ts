import * as vscode from 'vscode';
import {
	isTutorialNotificationChannel,
	type TutorialCatalog,
	type TutorialCategoryPreference,
	type TutorialNotificationChannel,
} from '../../shared/tutorials/tutorialCatalog';

const SUBSCRIPTION_STATE_KEY = 'kusto.tutorials.subscriptions.v1';

interface StoredTutorialCategoryPreference {
	categoryId: string;
	subscribed: boolean;
	channel: TutorialNotificationChannel;
	seenUpdateTokens: string[];
}

interface StoredTutorialSubscriptions {
	categories: StoredTutorialCategoryPreference[];
	lastDigestAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStored(value: unknown): StoredTutorialSubscriptions {
	if (!isRecord(value) || !Array.isArray(value.categories)) {
		return { categories: [] };
	}
	const categories: StoredTutorialCategoryPreference[] = [];
	for (const raw of value.categories) {
		if (!isRecord(raw) || typeof raw.categoryId !== 'string') {
			continue;
		}
		const channel = typeof raw.channel === 'string' && isTutorialNotificationChannel(raw.channel) ? raw.channel : 'off';
		categories.push({
			categoryId: raw.categoryId,
			subscribed: raw.subscribed === true,
			channel,
			seenUpdateTokens: Array.isArray(raw.seenUpdateTokens)
				? raw.seenUpdateTokens.filter((token): token is string => typeof token === 'string')
				: [],
		});
	}
	return {
		categories,
		lastDigestAt: typeof value.lastDigestAt === 'string' ? value.lastDigestAt : undefined,
	};
}

export class TutorialSubscriptionService {
	constructor(private readonly context: vscode.ExtensionContext) { }

	getPreferences(catalog: TutorialCatalog): TutorialCategoryPreference[] {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const byCategory = new Map(stored.categories.map(preference => [preference.categoryId, preference]));
		return catalog.categories.map(category => {
			const storedPreference = byCategory.get(category.id);
			return {
				categoryId: category.id,
				subscribed: storedPreference?.subscribed ?? false,
				channel: storedPreference?.channel ?? 'off',
				unseenCount: this.unseenTutorialCount(catalog, category.id, storedPreference?.seenUpdateTokens ?? []),
			};
		});
	}

	async setSubscription(categoryId: string, subscribed: boolean): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		preference.subscribed = subscribed;
		if (!subscribed) {
			preference.channel = 'off';
		} else if (preference.channel === 'off') {
			preference.channel = 'nextFileOpenPopup';
		}
		await this.writeState(stored);
	}

	async setChannel(categoryId: string, channel: TutorialNotificationChannel): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		preference.channel = channel;
		preference.subscribed = channel !== 'off';
		await this.writeState(stored);
	}

	async markTutorialSeen(categoryId: string, updateToken: string): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		if (!preference.seenUpdateTokens.includes(updateToken)) {
			preference.seenUpdateTokens.push(updateToken);
			preference.seenUpdateTokens = preference.seenUpdateTokens.slice(-200);
		}
		await this.writeState(stored);
	}

	async markCategorySeen(catalog: TutorialCatalog, categoryId: string): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		const tokens = catalog.tutorials
			.filter(tutorial => tutorial.categoryId === categoryId)
			.map(tutorial => tutorial.updateToken);
		preference.seenUpdateTokens = Array.from(new Set([...preference.seenUpdateTokens, ...tokens])).slice(-200);
		await this.writeState(stored);
	}

	getSubscribedCategoryIds(): string[] {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		return stored.categories
			.filter(preference => preference.subscribed && preference.channel !== 'off')
			.map(preference => preference.categoryId);
	}

	getLastDigestAt(): string | undefined {
		return normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY)).lastDigestAt;
	}

	async setLastDigestAt(value: string): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		stored.lastDigestAt = value;
		await this.writeState(stored);
	}

	getStoredPreference(categoryId: string): StoredTutorialCategoryPreference | undefined {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		return stored.categories.find(preference => preference.categoryId === categoryId);
	}

	private unseenTutorialCount(catalog: TutorialCatalog, categoryId: string, seenTokens: string[]): number {
		const seen = new Set(seenTokens);
		return catalog.tutorials.filter(tutorial => tutorial.categoryId === categoryId && !seen.has(tutorial.updateToken)).length;
	}

	private ensurePreference(stored: StoredTutorialSubscriptions, categoryId: string): StoredTutorialCategoryPreference {
		let preference = stored.categories.find(candidate => candidate.categoryId === categoryId);
		if (!preference) {
			preference = { categoryId, subscribed: false, channel: 'off', seenUpdateTokens: [] };
			stored.categories.push(preference);
		}
		return preference;
	}

	private async writeState(state: StoredTutorialSubscriptions): Promise<void> {
		await this.context.globalState.update(SUBSCRIPTION_STATE_KEY, state);
	}
}
