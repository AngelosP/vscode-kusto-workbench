export interface PersistedPythonSectionState {
	id?: string;
	type: 'python';
	name?: string;
	code?: string;
	output?: string;
	expanded?: boolean;
	editorHeightPx?: number;
}

export interface PythonSectionState extends PersistedPythonSectionState {
	id: string;
}

export interface PythonSectionPatch {
	name?: string;
	code?: string;
	output?: string;
	expanded?: boolean;
	editorHeightPx?: number | null;
}

export type PythonSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

function readOptionalFields(
	input: Record<string, unknown>,
	target: PersistedPythonSectionState | PythonSectionPatch,
	allowNullEditorHeight: boolean,
): string | undefined {
	for (const key of ['name', 'code', 'output'] as const) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'string') return `Python field "${key}" must be a string.`;
		target[key] = input[key];
	}
	if (hasOwn(input, 'expanded')) {
		if (typeof input.expanded !== 'boolean') return 'Python field "expanded" must be a boolean.';
		target.expanded = input.expanded;
	}
	if (hasOwn(input, 'editorHeightPx')) {
		if (allowNullEditorHeight && input.editorHeightPx === null) {
			(target as PythonSectionPatch).editorHeightPx = null;
		} else if (typeof input.editorHeightPx !== 'number'
			|| !Number.isFinite(input.editorHeightPx)
			|| input.editorHeightPx <= 0) {
			return 'Python field "editorHeightPx" must be a positive finite number.';
		} else {
			target.editorHeightPx = input.editorHeightPx;
		}
	}
	return undefined;
}

export function parsePythonSection(input: unknown): PythonSectionValidationResult<PythonSectionState> {
	if (!isRecord(input) || input.type !== 'python') {
		return { ok: false, error: 'Python section must be an object with type "python".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'Python section must have a safe, non-empty ID.' };
	}
	const value: PythonSectionState = { id, type: 'python' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parsePythonSectionPatch(input: unknown): PythonSectionValidationResult<PythonSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'Python patch must be an object.' };
	const value: PythonSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchPythonSection(section: PythonSectionState, patch: PythonSectionPatch): PythonSectionState {
	const next = { ...section, ...patch, id: section.id, type: 'python' } as PythonSectionState & {
		editorHeightPx?: number | null;
	};
	if (next.editorHeightPx === null) delete next.editorHeightPx;
	return next;
}

export function validatePersistedPythonSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'python') {
		return 'Python section must be an object with type "python".';
	}
	const value: PersistedPythonSectionState = { type: 'python' };
	return readOptionalFields(input, value, false);
}