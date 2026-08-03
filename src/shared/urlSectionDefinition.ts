export type UrlImageSizeMode = 'fill' | 'natural';
export type UrlImageAlign = 'left' | 'center' | 'right';
export type UrlImageOverflow = 'shrink' | 'scroll';

export interface PersistedUrlSectionState {
	id?: string;
	type: 'url';
	name?: string;
	url?: string;
	expanded?: boolean;
	outputHeightPx?: number;
	imageSizeMode?: UrlImageSizeMode;
	imageAlign?: UrlImageAlign;
	imageOverflow?: UrlImageOverflow;
}

export interface UrlSectionState extends PersistedUrlSectionState {
	id: string;
}

export interface UrlSectionPatch {
	name?: string;
	url?: string;
	expanded?: boolean;
	outputHeightPx?: number | null;
	imageSizeMode?: UrlImageSizeMode | null;
	imageAlign?: UrlImageAlign | null;
	imageOverflow?: UrlImageOverflow | null;
}

export type UrlSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const isImageSizeMode = (value: unknown): value is UrlImageSizeMode => value === 'fill' || value === 'natural';
const isImageAlign = (value: unknown): value is UrlImageAlign =>
	value === 'left' || value === 'center' || value === 'right';
const isImageOverflow = (value: unknown): value is UrlImageOverflow => value === 'shrink' || value === 'scroll';

function readOptionalFields(
	input: Record<string, unknown>,
	target: UrlSectionState | UrlSectionPatch | PersistedUrlSectionState,
	allowNullPresentation: boolean,
): string | undefined {
	for (const key of ['name', 'url'] as const) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'string') return `URL field "${key}" must be a string.`;
		target[key] = input[key];
	}
	if (hasOwn(input, 'expanded')) {
		if (typeof input.expanded !== 'boolean') return 'URL field "expanded" must be a boolean.';
		target.expanded = input.expanded;
	}
	if (hasOwn(input, 'outputHeightPx')) {
		if (allowNullPresentation && input.outputHeightPx === null) {
			(target as UrlSectionPatch).outputHeightPx = null;
		} else if (typeof input.outputHeightPx !== 'number'
			|| !Number.isFinite(input.outputHeightPx)
			|| input.outputHeightPx <= 0) {
			return 'URL field "outputHeightPx" must be a positive finite number.';
		} else {
			target.outputHeightPx = input.outputHeightPx;
		}
	}
	if (hasOwn(input, 'imageSizeMode')) {
		if (allowNullPresentation && input.imageSizeMode === null) {
			(target as UrlSectionPatch).imageSizeMode = null;
		} else if (!isImageSizeMode(input.imageSizeMode)) {
			return 'URL field "imageSizeMode" must be "fill" or "natural".';
		} else {
			target.imageSizeMode = input.imageSizeMode;
		}
	}
	if (hasOwn(input, 'imageAlign')) {
		if (allowNullPresentation && input.imageAlign === null) {
			(target as UrlSectionPatch).imageAlign = null;
		} else if (!isImageAlign(input.imageAlign)) {
			return 'URL field "imageAlign" must be "left", "center", or "right".';
		} else {
			target.imageAlign = input.imageAlign;
		}
	}
	if (hasOwn(input, 'imageOverflow')) {
		if (allowNullPresentation && input.imageOverflow === null) {
			(target as UrlSectionPatch).imageOverflow = null;
		} else if (!isImageOverflow(input.imageOverflow)) {
			return 'URL field "imageOverflow" must be "shrink" or "scroll".';
		} else {
			target.imageOverflow = input.imageOverflow;
		}
	}
	return undefined;
}

export function parseUrlSection(input: unknown): UrlSectionValidationResult<UrlSectionState> {
	if (!isRecord(input) || input.type !== 'url') {
		return { ok: false, error: 'URL section must be an object with type "url".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'URL section must have a safe, non-empty ID.' };
	}
	const value: UrlSectionState = { id, type: 'url' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parseUrlSectionPatch(input: unknown): UrlSectionValidationResult<UrlSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'URL patch must be an object.' };
	const value: UrlSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchUrlSection(section: UrlSectionState, patch: UrlSectionPatch): UrlSectionState {
	const next = { ...section, ...patch, id: section.id, type: 'url' } as UrlSectionState & {
		outputHeightPx?: number | null;
		imageSizeMode?: UrlImageSizeMode | null;
		imageAlign?: UrlImageAlign | null;
		imageOverflow?: UrlImageOverflow | null;
	};
	for (const key of ['outputHeightPx', 'imageSizeMode', 'imageAlign', 'imageOverflow'] as const) {
		if (next[key] === null) delete next[key];
	}
	return next;
}

export function validatePersistedUrlSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'url') {
		return 'URL section must be an object with type "url".';
	}
	const value: PersistedUrlSectionState = { type: 'url' };
	return readOptionalFields(input, value, false);
}
