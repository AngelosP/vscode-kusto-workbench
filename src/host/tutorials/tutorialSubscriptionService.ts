import * as vscode from 'vscode';
import {
	isTutorialNotificationCadence,
	isTutorialNotificationChannel,
	type TutorialCatalog,
	type TutorialCategoryPreference,
	type TutorialNotificationCadence,
	type TutorialNotificationChannel,
} from '../../shared/tutorials/tutorialCatalog';

const SUBSCRIPTION_STATE_KEY = 'kusto.tutorials.subscriptions.v1';

type ActiveTutorialNotificationChannel = Exclude<TutorialNotificationChannel, 'off'>;

interface StoredTutorialCategoryPreference {
	categoryId: string;
	subscribed: boolean;
	channel: TutorialNotificationChannel;
	previousChannel?: ActiveTutorialNotificationChannel;
	notificationCadence: TutorialNotificationCadence;
	muted?: boolean;
	lastNotifiedAt?: string;
	seenUpdateTokens: string[];
}

interface StoredTutorialSubscriptions {
	categories: StoredTutorialCategoryPreference[];
	lastDigestAt?: string;
}

function isActiveNotificationChannel(value: unknown): value is ActiveTutorialNotificationChannel {
	return value === 'nextFileOpenPopup' || value === 'vscodeNotification';
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
		const notificationCadence = typeof raw.notificationCadence === 'string' && isTutorialNotificationCadence(raw.notificationCadence) ? raw.notificationCadence : 'daily';
		categories.push({
			categoryId: raw.categoryId,
			subscribed: raw.subscribed === true,
			channel,
			previousChannel: isActiveNotificationChannel(raw.previousChannel) ? raw.previousChannel : isActiveNotificationChannel(channel) ? channel : undefined,
			notificationCadence,
			muted: raw.muted === true,
			lastNotifiedAt: typeof raw.lastNotifiedAt === 'string' ? raw.lastNotifiedAt : undefined,
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
				notificationCadence: storedPreference?.notificationCadence ?? 'daily',
				muted: storedPreference?.muted === true,
				unseenCount: this.unseenTutorialCount(catalog, category.id, storedPreference?.seenUpdateTokens ?? []),
			};
		});
	}

	getUnseenTutorialIds(catalog: TutorialCatalog): Set<string> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const byCategory = new Map(stored.categories.map(preference => [preference.categoryId, preference]));
		return new Set(catalog.content
			.filter(tutorial => {
				const seenTokens = byCategory.get(tutorial.categoryId)?.seenUpdateTokens ?? [];
				return !seenTokens.includes(tutorial.updateToken);
			})
			.map(tutorial => tutorial.id));
	}

	async setSubscription(categoryId: string, subscribed: boolean): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		preference.subscribed = subscribed;
		preference.muted = false;
		if (!subscribed) {
			this.disablePreference(preference);
		} else if (preference.channel === 'off') {
			this.unmutePreference(preference);
		}
		await this.writeState(stored);
	}

	async setSubscriptions(categoryIds: readonly string[], subscribed: boolean): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		for (const categoryId of categoryIds) {
			const preference = this.ensurePreference(stored, categoryId);
			preference.subscribed = subscribed;
			preference.muted = false;
			if (!subscribed) {
				this.disablePreference(preference);
			} else if (preference.channel === 'off') {
				this.unmutePreference(preference);
			}
		}
		await this.writeState(stored);
	}

	async setChannel(categoryId: string, channel: TutorialNotificationChannel): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		if (channel === 'off') {
			this.mutePreference(preference);
		} else {
			preference.channel = channel;
			preference.previousChannel = channel;
			preference.subscribed = true;
			preference.muted = false;
		}
		await this.writeState(stored);
	}

	async setMuted(categoryId: string, muted: boolean): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		if (muted) {
			this.mutePreference(preference);
		} else {
			this.unmutePreference(preference);
		}
		await this.writeState(stored);
	}

	async setNotificationCadence(categoryId: string, notificationCadence: TutorialNotificationCadence): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		preference.notificationCadence = notificationCadence;
		await this.writeState(stored);
	}

	async markCategoryNotified(categoryId: string, notifiedAt = new Date().toISOString()): Promise<void> {
		const stored = normalizeStored(this.context.globalState.get(SUBSCRIPTION_STATE_KEY));
		const preference = this.ensurePreference(stored, categoryId);
		preference.lastNotifiedAt = notifiedAt;
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
		return catalog.content.filter(tutorial => tutorial.categoryId === categoryId && !seen.has(tutorial.updateToken)).length;
	}

	private ensurePreference(stored: StoredTutorialSubscriptions, categoryId: string): StoredTutorialCategoryPreference {
		let preference = stored.categories.find(candidate => candidate.categoryId === categoryId);
		if (!preference) {
			preference = { categoryId, subscribed: false, channel: 'off', notificationCadence: 'daily', muted: false, seenUpdateTokens: [] };
			stored.categories.push(preference);
		}
		return preference;
	}

	private mutePreference(preference: StoredTutorialCategoryPreference): void {
		if (isActiveNotificationChannel(preference.channel)) {
			preference.previousChannel = preference.channel;
		}
		preference.channel = 'off';
		preference.subscribed = false;
		preference.muted = true;
	}

	private disablePreference(preference: StoredTutorialCategoryPreference): void {
		if (isActiveNotificationChannel(preference.channel)) {
			preference.previousChannel = preference.channel;
		}
		preference.channel = 'off';
		preference.subscribed = false;
		preference.muted = false;
	}

	private unmutePreference(preference: StoredTutorialCategoryPreference): void {
		const channel = preference.previousChannel ?? 'nextFileOpenPopup';
		preference.channel = channel;
		preference.previousChannel = channel;
		preference.subscribed = true;
		preference.muted = false;
	}

	private async writeState(state: StoredTutorialSubscriptions): Promise<void> {
		await this.context.globalState.update(SUBSCRIPTION_STATE_KEY, state);
	}
}
