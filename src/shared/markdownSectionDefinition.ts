export type MarkdownMode = 'preview' | 'markdown' | 'wysiwyg';
export type MarkdownTab = 'edit' | 'preview';

export interface PersistedMarkdownSectionState {
	id?: string;
	type: 'markdown';
	title?: string;
	text?: string;
	tab?: MarkdownTab;
	expanded?: boolean;
	mode?: MarkdownMode;
	editorHeightPx?: number;
}

export interface MarkdownSectionState extends PersistedMarkdownSectionState {
	id: string;
}

export interface MarkdownSectionPatch {
	title?: string;
	text?: string;
	tab?: MarkdownTab;
	expanded?: boolean;
	mode?: MarkdownMode;
	editorHeightPx?: number | null;
}

export type MarkdownSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const isMarkdownMode = (value: unknown): value is MarkdownMode =>
	value === 'preview' || value === 'markdown' || value === 'wysiwyg';
const isMarkdownTab = (value: unknown): value is MarkdownTab => value === 'edit' || value === 'preview';

function readOptionalString(
	input: Record<string, unknown>,
	key: 'title' | 'text',
	target: MarkdownSectionState | MarkdownSectionPatch,
): string | undefined {
	if (!hasOwn(input, key)) return undefined;
	if (typeof input[key] !== 'string') return `Markdown field "${key}" must be a string.`;
	target[key] = input[key];
	return undefined;
}

function readOptionalFields(
	input: Record<string, unknown>,
	target: MarkdownSectionState | MarkdownSectionPatch,
	allowNullEditorHeight: boolean,
): string | undefined {
	for (const key of ['title', 'text'] as const) {
		const error = readOptionalString(input, key, target);
		if (error) return error;
	}
	if (hasOwn(input, 'tab')) {
		if (!isMarkdownTab(input.tab)) return 'Markdown field "tab" must be "edit" or "preview".';
		target.tab = input.tab;
	}
	if (hasOwn(input, 'expanded')) {
		if (typeof input.expanded !== 'boolean') return 'Markdown field "expanded" must be a boolean.';
		target.expanded = input.expanded;
	}
	if (hasOwn(input, 'mode')) {
		if (!isMarkdownMode(input.mode)) return 'Markdown field "mode" is invalid.';
		target.mode = input.mode;
	}
	if (hasOwn(input, 'editorHeightPx')) {
		if (allowNullEditorHeight && input.editorHeightPx === null) {
			target.editorHeightPx = null;
			return undefined;
		}
		if (typeof input.editorHeightPx !== 'number'
			|| !Number.isFinite(input.editorHeightPx)
			|| input.editorHeightPx <= 0) {
			return 'Markdown field "editorHeightPx" must be a positive finite number.';
		}
		target.editorHeightPx = input.editorHeightPx;
	}
	return undefined;
}

export function parseMarkdownSection(input: unknown): MarkdownSectionValidationResult<MarkdownSectionState> {
	if (!isRecord(input) || input.type !== 'markdown') {
		return { ok: false, error: 'Markdown section must be an object with type "markdown".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'Markdown section must have a safe, non-empty ID.' };
	}
	const value: MarkdownSectionState = { id, type: 'markdown' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parseMarkdownSectionPatch(input: unknown): MarkdownSectionValidationResult<MarkdownSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'Markdown patch must be an object.' };
	const value: MarkdownSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchMarkdownSection(
	section: MarkdownSectionState,
	patch: MarkdownSectionPatch,
): MarkdownSectionState {
	const next = { ...section, ...patch, id: section.id, type: 'markdown' } as MarkdownSectionState & {
		editorHeightPx?: number | null;
	};
	if (next.editorHeightPx === null) delete next.editorHeightPx;
	return next;
}

export function validatePersistedMarkdownSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'markdown') {
		return 'Markdown section must be an object with type "markdown".';
	}
	const value: PersistedMarkdownSectionState = { type: 'markdown' };
	return readOptionalFields(input, value, false);
}