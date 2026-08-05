import type { PowerBiUpgradeNoticeState } from './htmlDashboardUpgrade';

export interface PbiPublishInfo {
	workspaceId: string;
	workspaceName?: string;
	semanticModelId: string;
	reportId: string;
	reportName: string;
	reportUrl: string;
	dataMode?: 'import' | 'directQuery';
}

export interface PersistedHtmlSectionState {
	id?: string;
	type: 'html';
	name?: string;
	code?: string;
	mode?: 'code' | 'preview';
	expanded?: boolean;
	editorHeightPx?: number;
	previewHeightPx?: number;
	previewHeightUserSet?: boolean;
	dataSourceIds?: string[];
	pbiPublishInfo?: PbiPublishInfo;
	powerBiUpgradeNotice?: PowerBiUpgradeNoticeState;
}

export interface HtmlSectionState extends PersistedHtmlSectionState {
	id: string;
}

type HtmlConfiguration = Omit<PersistedHtmlSectionState, 'id' | 'type'>;
export type HtmlSectionPatch = {
	[K in keyof HtmlConfiguration]?: Exclude<HtmlConfiguration[K], undefined> | null;
};

export type HtmlSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

type JsonRecord = Record<string, unknown>;
type MutableHtmlState = HtmlSectionState | PersistedHtmlSectionState | HtmlSectionPatch;

const stringFields = ['name', 'code'] as const;
const booleanFields = ['expanded', 'previewHeightUserSet'] as const;
const numberFields = ['editorHeightPx', 'previewHeightPx'] as const;
const configurationKeys = new Set<string>([
	...stringFields,
	...booleanFields,
	...numberFields,
	'mode', 'dataSourceIds', 'pbiPublishInfo', 'powerBiUpgradeNotice',
]);

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is JsonRecord =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const setOwn = (target: object, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

function readScalarFields(input: JsonRecord, target: MutableHtmlState): string | undefined {
	for (const key of stringFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'string') return `HTML field "${key}" must be a string.`;
		setOwn(target, key, input[key]);
	}
	if (hasOwn(input, 'mode')) {
		if (input.mode !== 'code' && input.mode !== 'preview') {
			return 'HTML field "mode" must be "code" or "preview".';
		}
		setOwn(target, 'mode', input.mode);
	}
	for (const key of booleanFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'boolean') return `HTML field "${key}" must be a boolean.`;
		setOwn(target, key, input[key]);
	}
	for (const key of numberFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
			return `HTML field "${key}" must be a finite number.`;
		}
		setOwn(target, key, input[key]);
	}
	return undefined;
}

function readDataSourceIds(input: JsonRecord, target: MutableHtmlState): string | undefined {
	if (!hasOwn(input, 'dataSourceIds')) return undefined;
	if (!Array.isArray(input.dataSourceIds) || !input.dataSourceIds.every(item => typeof item === 'string')) {
		return 'HTML field "dataSourceIds" must be an array of strings.';
	}
	setOwn(target, 'dataSourceIds', [...input.dataSourceIds]);
	return undefined;
}

function readPbiPublishInfo(input: JsonRecord, target: MutableHtmlState): string | undefined {
	if (!hasOwn(input, 'pbiPublishInfo')) return undefined;
	if (!isRecord(input.pbiPublishInfo)) return 'HTML field "pbiPublishInfo" must be an object.';
	const source = input.pbiPublishInfo;
	const requiredFields = ['workspaceId', 'semanticModelId', 'reportId', 'reportName', 'reportUrl'] as const;
	for (const key of requiredFields) {
		if (typeof source[key] !== 'string') return `HTML field "pbiPublishInfo.${key}" must be a string.`;
	}
	if (source.workspaceName !== undefined && typeof source.workspaceName !== 'string') {
		return 'HTML field "pbiPublishInfo.workspaceName" must be a string.';
	}
	if (source.dataMode !== undefined && source.dataMode !== 'import' && source.dataMode !== 'directQuery') {
		return 'HTML field "pbiPublishInfo.dataMode" must be "import" or "directQuery".';
	}
	const value: PbiPublishInfo = {
		workspaceId: source.workspaceId as string,
		semanticModelId: source.semanticModelId as string,
		reportId: source.reportId as string,
		reportName: source.reportName as string,
		reportUrl: source.reportUrl as string,
	};
	if (source.workspaceName !== undefined) value.workspaceName = source.workspaceName;
	if (source.dataMode !== undefined) value.dataMode = source.dataMode;
	setOwn(target, 'pbiPublishInfo', value);
	return undefined;
}

function readPowerBiUpgradeNotice(input: JsonRecord, target: MutableHtmlState): string | undefined {
	if (!hasOwn(input, 'powerBiUpgradeNotice')) return undefined;
	if (!isRecord(input.powerBiUpgradeNotice)) {
		return 'HTML field "powerBiUpgradeNotice" must be an object.';
	}
	const source = input.powerBiUpgradeNotice;
	if (source.dismissedForSection !== undefined && typeof source.dismissedForSection !== 'boolean') {
		return 'HTML field "powerBiUpgradeNotice.dismissedForSection" must be a boolean.';
	}
	if (source.dismissedForVersion !== undefined
		&& (typeof source.dismissedForVersion !== 'number' || !Number.isFinite(source.dismissedForVersion))) {
		return 'HTML field "powerBiUpgradeNotice.dismissedForVersion" must be a finite number.';
	}
	if (source.dismissedForSignature !== undefined && typeof source.dismissedForSignature !== 'string') {
		return 'HTML field "powerBiUpgradeNotice.dismissedForSignature" must be a string.';
	}
	if (source.dismissedAt !== undefined && typeof source.dismissedAt !== 'string') {
		return 'HTML field "powerBiUpgradeNotice.dismissedAt" must be a string.';
	}
	const value: PowerBiUpgradeNoticeState = {};
	if (source.dismissedForSection !== undefined) value.dismissedForSection = source.dismissedForSection;
	if (source.dismissedForVersion !== undefined) value.dismissedForVersion = source.dismissedForVersion;
	if (source.dismissedForSignature !== undefined) value.dismissedForSignature = source.dismissedForSignature;
	if (source.dismissedAt !== undefined) value.dismissedAt = source.dismissedAt;
	setOwn(target, 'powerBiUpgradeNotice', value);
	return undefined;
}

function readOptionalFields(
	input: JsonRecord,
	target: MutableHtmlState,
	allowNullDeletion: boolean,
): string | undefined {
	if (allowNullDeletion) {
		for (const key of Object.keys(input)) {
			if (configurationKeys.has(key) && input[key] === null) setOwn(target, key, null);
		}
	}
	const nonNullInput: JsonRecord = {};
	for (const [key, value] of Object.entries(input)) {
		if (!(allowNullDeletion && value === null)) setOwn(nonNullInput, key, value);
	}
	return readScalarFields(nonNullInput, target)
		?? readDataSourceIds(nonNullInput, target)
		?? readPbiPublishInfo(nonNullInput, target)
		?? readPowerBiUpgradeNotice(nonNullInput, target);
}

export function parseHtmlSection(input: unknown): HtmlSectionValidationResult<HtmlSectionState> {
	if (!isRecord(input) || input.type !== 'html') {
		return { ok: false, error: 'HTML section must be an object with type "html".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'HTML section must have a safe, non-empty ID.' };
	}
	const value: HtmlSectionState = { id, type: 'html' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parseHtmlSectionPatch(input: unknown): HtmlSectionValidationResult<HtmlSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'HTML patch must be an object.' };
	const value: HtmlSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchHtmlSection(section: HtmlSectionState, patch: HtmlSectionPatch): HtmlSectionState {
	const next = parseHtmlSection(section);
	if (!next.ok) return { id: section.id, type: 'html' };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete (next.value as unknown as JsonRecord)[key];
		else setOwn(next.value, key, value);
	}
	next.value.id = section.id;
	next.value.type = 'html';
	return next.value;
}

export function validatePersistedHtmlSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'html') {
		return 'HTML section must be an object with type "html".';
	}
	const value: PersistedHtmlSectionState = { type: 'html' };
	return readOptionalFields(input, value, false);
}