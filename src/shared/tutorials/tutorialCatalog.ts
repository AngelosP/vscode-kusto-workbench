export const TUTORIAL_CATALOG_SCHEMA_VERSION = 1;

export const TUTORIAL_NOTIFICATION_CHANNELS = [
	'off',
	'nextFileOpenPopup',
	'vscodeNotification',
] as const;

export type TutorialNotificationChannel = typeof TUTORIAL_NOTIFICATION_CHANNELS[number];

export const TUTORIAL_NOTIFICATION_CADENCES = [
	'daily',
	'weekly',
	'monthly',
] as const;

export type TutorialNotificationCadence = typeof TUTORIAL_NOTIFICATION_CADENCES[number];

export const TUTORIAL_VIEWER_MODES = [
	'compact',
	'focused',
	'standard',
] as const;

export type TutorialViewerMode = typeof TUTORIAL_VIEWER_MODES[number];

export const TUTORIAL_CONNECTION_REQUIRED_MESSAGE = 'Kusto Workbench tutorials require a connection to the GitHub repo, but it cannot be established right now.';

export interface TutorialCategory {
	id: string;
	title: string;
	description?: string;
	sortOrder?: number;
}

export interface TutorialItem {
	id: string;
	categoryId: string;
	contentUrl: string;
	minExtensionVersion: string;
	updateToken: string;
}

export interface TutorialCatalog {
	schemaVersion: typeof TUTORIAL_CATALOG_SCHEMA_VERSION;
	generatedAt: string;
	categories: TutorialCategory[];
	content: TutorialItem[];
}

export interface TutorialSummary {
	id: string;
	displayName: string;
	contentText?: string;
	categoryId: string;
	minExtensionVersion: string;
	compatible: boolean;
	unseen: boolean;
}

export interface TutorialSummaryContent {
	displayName?: string;
	contentText?: string;
}

export interface TutorialCatalogValidationResult {
	catalog: TutorialCatalog | null;
	errors: string[];
	warnings: string[];
	incompatibleTutorialIds: string[];
}

export interface TutorialCategoryPreference {
	categoryId: string;
	subscribed: boolean;
	channel: TutorialNotificationChannel;
	notificationCadence: TutorialNotificationCadence;
	muted?: boolean;
	unseenCount: number;
}

export interface TutorialViewerCatalog {
	schemaVersion: typeof TUTORIAL_CATALOG_SCHEMA_VERSION;
	generatedAt: string;
	categories: TutorialCategory[];
	content: TutorialSummary[];
}

export interface TutorialViewerStatus {
	source: 'remote' | 'cache' | 'localDevelopment' | 'unavailable';
	stale: boolean;
	lastUpdated?: string;
	errors: string[];
	warnings: string[];
}

export interface TutorialViewerSnapshot {
	catalog: TutorialViewerCatalog;
	preferences: TutorialCategoryPreference[];
	status: TutorialViewerStatus;
	tutorialsEnabled: boolean;
	preferredMode: TutorialViewerMode;
	selectedCategoryId?: string;
	selectedTutorialId?: string;
}

const BLOCKED_URL_PROTOCOLS = new Set([
	'command:',
	'javascript:',
	'vscode:',
	'vscode-insiders:',
	'file:',
	'data:',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isTutorialNotificationChannel(value: string): value is TutorialNotificationChannel {
	return (TUTORIAL_NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isTutorialNotificationCadence(value: string): value is TutorialNotificationCadence {
	return (TUTORIAL_NOTIFICATION_CADENCES as readonly string[]).includes(value);
}

export function isTutorialViewerMode(value: string): value is TutorialViewerMode {
	return (TUTORIAL_VIEWER_MODES as readonly string[]).includes(value);
}

export function isSafeTutorialContentUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith('//') || trimmed.includes('\\')) {
		return false;
	}

	const protocolMatch = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed);
	if (!protocolMatch) {
		return !trimmed.startsWith('/') && !trimmed.split('/').includes('..');
	}

	const protocol = protocolMatch[0].toLowerCase();
	if (BLOCKED_URL_PROTOCOLS.has(protocol)) {
		return false;
	}
	return protocol === 'https:';
}

export function isSemverLikeVersion(value: string): boolean {
	return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim());
}

function parseVersion(value: string): [number, number, number] | null {
	const normalized = value.trim().replace(/^v/i, '');
	if (!normalized || /placeholder|dev|local/i.test(normalized)) {
		return null;
	}
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(normalized);
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareExtensionVersions(left: string, right: string): number | null {
	const parsedLeft = parseVersion(left);
	const parsedRight = parseVersion(right);
	if (!parsedLeft || !parsedRight) {
		return null;
	}
	for (let index = 0; index < 3; index += 1) {
		if (parsedLeft[index] !== parsedRight[index]) {
			return parsedLeft[index] > parsedRight[index] ? 1 : -1;
		}
	}
	return 0;
}

export function isExtensionVersionCompatible(installedVersion: string, minExtensionVersion: string): boolean {
	const comparison = compareExtensionVersions(installedVersion, minExtensionVersion);
	return comparison === null || comparison >= 0;
}

function normalizeCategory(value: unknown, errors: string[], seenIds: Set<string>, index: number): TutorialCategory | null {
	if (!isRecord(value)) {
		errors.push(`categories[${index}] must be an object.`);
		return null;
	}
	const id = asString(value.id);
	const title = asString(value.title);
	if (!id) {
		errors.push(`categories[${index}].id is required.`);
	}
	if (!title) {
		errors.push(`categories[${index}].title is required.`);
	}
	if (!id || !title) {
		return null;
	}
	if (seenIds.has(id)) {
		errors.push(`Duplicate category id '${id}'.`);
		return null;
	}
	seenIds.add(id);
	const category: TutorialCategory = { id, title };
	const description = asString(value.description);
	if (description) {
		category.description = description;
	}
	const sortOrder = asPositiveNumber(value.sortOrder);
	if (sortOrder !== undefined) {
		category.sortOrder = sortOrder;
	}
	return category;
}

function normalizeTutorial(
	value: unknown,
	errors: string[],
	warnings: string[],
	categoryIds: Set<string>,
	seenIds: Set<string>,
	installedVersion: string,
	incompatibleTutorialIds: string[],
	index: number,
): TutorialItem | null {
	if (!isRecord(value)) {
		errors.push(`content[${index}] must be an object.`);
		return null;
	}

	const id = asString(value.id);
	const categoryId = asString(value.categoryId);
	const contentUrl = asString(value.contentUrl);
	const minExtensionVersion = asString(value.minExtensionVersion);
	const updateToken = asString(value.updateToken);

	if (!id) errors.push(`content[${index}].id is required.`);
	if (!categoryId) errors.push(`content[${index}].categoryId is required.`);
	if (!contentUrl) errors.push(`content[${index}].contentUrl is required.`);
	if (!minExtensionVersion) errors.push(`content[${index}].minExtensionVersion is required.`);
	if (!updateToken) errors.push(`content[${index}].updateToken is required.`);

	if (!id || !categoryId || !contentUrl || !minExtensionVersion || !updateToken) {
		return null;
	}
	if (seenIds.has(id)) {
		errors.push(`Duplicate tutorial id '${id}'.`);
		return null;
	}
	seenIds.add(id);
	if (!categoryIds.has(categoryId)) {
		errors.push(`tutorial '${id}' references unknown category '${categoryId}'.`);
		return null;
	}
	if (!isSafeTutorialContentUrl(contentUrl)) {
		errors.push(`tutorial '${id}' has unsafe contentUrl '${contentUrl}'.`);
		return null;
	}
	if (!isSemverLikeVersion(minExtensionVersion)) {
		errors.push(`tutorial '${id}' has invalid minExtensionVersion '${minExtensionVersion}'.`);
		return null;
	}
	if (!isExtensionVersionCompatible(installedVersion, minExtensionVersion)) {
		incompatibleTutorialIds.push(id);
		warnings.push(`tutorial '${id}' requires Kusto Workbench ${minExtensionVersion} or newer.`);
	}

	const tutorial: TutorialItem = {
		id,
		categoryId,
		contentUrl,
		minExtensionVersion,
		updateToken,
	};
	return tutorial;
}

export function validateTutorialCatalog(input: unknown, installedVersion: string): TutorialCatalogValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const incompatibleTutorialIds: string[] = [];

	if (!isRecord(input)) {
		return { catalog: null, errors: ['Catalog must be an object.'], warnings, incompatibleTutorialIds };
	}
	if (input.schemaVersion !== TUTORIAL_CATALOG_SCHEMA_VERSION) {
		errors.push(`schemaVersion must be ${TUTORIAL_CATALOG_SCHEMA_VERSION}.`);
	}
	const generatedAt = asString(input.generatedAt);
	if (!generatedAt) {
		errors.push('generatedAt is required.');
	}
	if (!Array.isArray(input.categories)) {
		errors.push('categories must be an array.');
	}
	if (!Array.isArray(input.content)) {
		errors.push('content must be an array.');
	}
	if (errors.length > 0 || !generatedAt || !Array.isArray(input.categories) || !Array.isArray(input.content)) {
		return { catalog: null, errors, warnings, incompatibleTutorialIds };
	}

	const seenCategoryIds = new Set<string>();
	const categories = input.categories
		.map((category, index) => normalizeCategory(category, errors, seenCategoryIds, index))
		.filter((category): category is TutorialCategory => !!category)
		.sort(sortCatalogEntries);

	const categoryIds = new Set(categories.map(category => category.id));
	const seenTutorialIds = new Set<string>();
	const content = input.content
		.map((tutorial, index) => normalizeTutorial(tutorial, errors, warnings, categoryIds, seenTutorialIds, installedVersion, incompatibleTutorialIds, index))
		.filter((tutorial): tutorial is TutorialItem => !!tutorial);

	if (categories.length === 0) {
		errors.push('Catalog must contain at least one category.');
	}
	if (content.length === 0) {
		errors.push('Catalog must contain at least one content item.');
	}

	return {
		catalog: errors.length === 0 ? { schemaVersion: TUTORIAL_CATALOG_SCHEMA_VERSION, generatedAt, categories, content } : null,
		errors,
		warnings,
		incompatibleTutorialIds,
	};
}

export function sortCatalogEntries<T extends { title: string; sortOrder?: number }>(left: T, right: T): number {
	const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
	return leftOrder === rightOrder ? left.title.localeCompare(right.title) : leftOrder - rightOrder;
}

export function deriveTutorialDisplayName(tutorial: Pick<TutorialItem, 'id' | 'contentUrl'>): string {
	const contentPath = tutorial.contentUrl.split(/[?#]/, 1)[0] ?? '';
	const fileName = contentPath.split('/').filter(Boolean).pop() ?? '';
	const stem = fileName.replace(/\.[^.]+$/, '') || tutorial.id;
	return toDisplayName(stem || tutorial.id);
}

function toDisplayName(value: string): string {
	const words = value.split(/[-_\s]+/).map(word => word.trim()).filter(Boolean);
	if (!words.length) {
		return 'Tutorial';
	}
	return words.map((word, index) => {
		const normalized = word.toLowerCase();
		return index === 0 ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : normalized;
	}).join(' ');
}

export function summarizeTutorial(tutorial: TutorialItem, installedVersion: string, summaryContent: TutorialSummaryContent = {}): TutorialSummary {
	return {
		id: tutorial.id,
		displayName: summaryContent.displayName ?? deriveTutorialDisplayName(tutorial),
		contentText: summaryContent.contentText,
		categoryId: tutorial.categoryId,
		minExtensionVersion: tutorial.minExtensionVersion,
		compatible: isExtensionVersionCompatible(installedVersion, tutorial.minExtensionVersion),
		unseen: false,
	};
}

export function toTutorialViewerCatalog(catalog: TutorialCatalog, installedVersion: string, summaryContent: ReadonlyMap<string, TutorialSummaryContent> = new Map()): TutorialViewerCatalog {
	return {
		schemaVersion: catalog.schemaVersion,
		generatedAt: catalog.generatedAt,
		categories: [...catalog.categories].sort(sortCatalogEntries),
		content: catalog.content.map(tutorial => summarizeTutorial(tutorial, installedVersion, summaryContent.get(tutorial.id))),
	};
}

export function searchTutorials(
	tutorials: readonly TutorialSummary[],
	categories: readonly TutorialCategory[],
	query: string,
	categoryId: string | null = null,
): TutorialSummary[] {
	const normalizedQuery = query.trim().toLowerCase();
	const tokens = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
	const categoryTitleById = new Map(categories.map(category => [category.id, category.title]));
	return tutorials.filter(tutorial => {
		if (categoryId && tutorial.categoryId !== categoryId) {
			return false;
		}
		if (!tokens.length) {
			return true;
		}
		const haystack = [
			tutorial.displayName,
			tutorial.contentText ?? '',
			tutorial.id,
			categoryTitleById.get(tutorial.categoryId) ?? '',
		].join(' ').toLowerCase();
		return tokens.every(token => haystack.includes(token));
	});
}
