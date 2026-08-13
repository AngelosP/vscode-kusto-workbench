type UnknownRecord = Record<string, unknown>;

export type EditingPreferencesParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type EditingPreferencesAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: EditingPreferencesParseResult<T> }>;

type FieldParseResult<T> = EditingPreferencesParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type SetCaretDocsEnabledMessage = {
	type: 'setCaretDocsEnabled';
	enabled: boolean;
};

export type SetAutoTriggerAutocompleteEnabledMessage = {
	type: 'setAutoTriggerAutocompleteEnabled';
	enabled: boolean;
};

export type SetCopilotInlineCompletionsEnabledMessage = {
	type: 'setCopilotInlineCompletionsEnabled';
	enabled: boolean;
};

export type EditingPreferencesWebviewMessage =
	| SetCaretDocsEnabledMessage
	| SetAutoTriggerAutocompleteEnabledMessage
	| SetCopilotInlineCompletionsEnabledMessage;

export type EditingPreferencesDataMessage = {
	type: 'editingPreferencesData';
	revision: number;
	caretDocsEnabled: boolean;
	caretDocsEnabledUserSet: boolean;
	autoTriggerAutocompleteEnabled: boolean;
	autoTriggerAutocompleteEnabledUserSet: boolean;
	copilotInlineCompletionsEnabled: boolean;
	copilotInlineCompletionsEnabledUserSet: boolean;
};

export type EditingPreferencesHostMessage = EditingPreferencesDataMessage;

const webviewMessageTypes = new Set([
	'setCaretDocsEnabled',
	'setAutoTriggerAutocompleteEnabled',
	'setCopilotInlineCompletionsEnabled',
]);
const hostMessageTypes = new Set(['editingPreferencesData']);
const capturedHostMessages = new WeakSet<object>();

function failure<T>(error: string): EditingPreferencesParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	if (!value || typeof value !== 'object') return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): KnownTypeInspection {
	const inputType = typeof input;
	if (!input || (inputType !== 'object' && inputType !== 'function')) return { recognized: false };
	try {
		let owner: object | null = input as object;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) {
				return { recognized: true, type: failure('type prototype inspection was cyclic.') };
			}
			seen.add(owner);
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'type');
			if (descriptor) {
				const isDataProperty = Object.prototype.hasOwnProperty.call(descriptor, 'value');
				if (isDataProperty && typeof descriptor.value === 'string' && !types.has(descriptor.value)) {
					return { recognized: false };
				}
				if (owner !== input || !descriptor.enumerable || !isDataProperty) {
					return {
						recognized: true,
						type: failure('type must be an own enumerable data property.'),
					};
				}
				return typeof descriptor.value === 'string'
					? { recognized: true, type: { ok: true, value: descriptor.value } }
					: { recognized: true, type: failure('type must be a string.') };
			}
			owner = Object.getPrototypeOf(owner);
		}
		return { recognized: true, type: failure('type could not be resolved.') };
	} catch {
		return { recognized: true, type: failure('type could not be inspected.') };
	}
}

function readOwnEnumerableDataProperty(input: UnknownRecord, key: string): FieldParseResult<unknown> {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return failure(`${key} must be an own enumerable data property.`);
		}
		return { ok: true, value: descriptor.value };
	} catch {
		return failure(`${key} could not be inspected.`);
	}
}

function readBoolean(input: UnknownRecord, key: string): FieldParseResult<boolean> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'boolean'
		? { ok: true, value: field.value }
		: failure(`${key} must be a boolean.`);
}

function readNonnegativeSafeInteger(input: UnknownRecord, key: string): FieldParseResult<number> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'number' && Number.isSafeInteger(field.value) && field.value >= 0
		? { ok: true, value: field.value }
		: failure(`${key} must be a non-negative safe integer.`);
}

function parseEditingPreferencesWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): EditingPreferencesParseResult<EditingPreferencesWebviewMessage> {
	if (!isRecord(input)) return failure('Editing preferences request must be an object.');
	if (!type.ok) return failure(type.error);
	if (!webviewMessageTypes.has(type.value)) return failure('Unknown editing preferences request type.');
	const enabled = readBoolean(input, 'enabled');
	if (!enabled.ok) return failure(enabled.error);
	if (type.value === 'setCaretDocsEnabled') {
		return { ok: true, value: { type: 'setCaretDocsEnabled', enabled: enabled.value } };
	}
	if (type.value === 'setAutoTriggerAutocompleteEnabled') {
		return { ok: true, value: { type: 'setAutoTriggerAutocompleteEnabled', enabled: enabled.value } };
	}
	return { ok: true, value: { type: 'setCopilotInlineCompletionsEnabled', enabled: enabled.value } };
}

function parseEditingPreferencesHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): EditingPreferencesParseResult<EditingPreferencesHostMessage> {
	if (!isRecord(input)) return failure('Editing preferences delivery must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'editingPreferencesData') return failure('Unknown editing preferences delivery type.');
	if (capturedHostMessages.has(input)) {
		return { ok: true, value: input as EditingPreferencesDataMessage };
	}
	const revision = readNonnegativeSafeInteger(input, 'revision');
	if (!revision.ok) return failure(revision.error);
	const caretDocsEnabled = readBoolean(input, 'caretDocsEnabled');
	if (!caretDocsEnabled.ok) return failure(caretDocsEnabled.error);
	const caretDocsEnabledUserSet = readBoolean(input, 'caretDocsEnabledUserSet');
	if (!caretDocsEnabledUserSet.ok) return failure(caretDocsEnabledUserSet.error);
	const autoTriggerAutocompleteEnabled = readBoolean(input, 'autoTriggerAutocompleteEnabled');
	if (!autoTriggerAutocompleteEnabled.ok) return failure(autoTriggerAutocompleteEnabled.error);
	const autoTriggerAutocompleteEnabledUserSet = readBoolean(input, 'autoTriggerAutocompleteEnabledUserSet');
	if (!autoTriggerAutocompleteEnabledUserSet.ok) return failure(autoTriggerAutocompleteEnabledUserSet.error);
	const copilotInlineCompletionsEnabled = readBoolean(input, 'copilotInlineCompletionsEnabled');
	if (!copilotInlineCompletionsEnabled.ok) return failure(copilotInlineCompletionsEnabled.error);
	const copilotInlineCompletionsEnabledUserSet = readBoolean(input, 'copilotInlineCompletionsEnabledUserSet');
	if (!copilotInlineCompletionsEnabledUserSet.ok) return failure(copilotInlineCompletionsEnabledUserSet.error);
	const captured = Object.freeze({
		type: 'editingPreferencesData' as const,
		revision: revision.value,
		caretDocsEnabled: caretDocsEnabled.value,
		caretDocsEnabledUserSet: caretDocsEnabledUserSet.value,
		autoTriggerAutocompleteEnabled: autoTriggerAutocompleteEnabled.value,
		autoTriggerAutocompleteEnabledUserSet: autoTriggerAutocompleteEnabledUserSet.value,
		copilotInlineCompletionsEnabled: copilotInlineCompletionsEnabled.value,
		copilotInlineCompletionsEnabledUserSet: copilotInlineCompletionsEnabledUserSet.value,
	});
	capturedHostMessages.add(captured);
	return {
		ok: true,
		value: captured,
	};
}

export function isEditingPreferencesWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isEditingPreferencesHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitEditingPreferencesWebviewMessage(
	input: unknown,
): EditingPreferencesAdmissionResult<EditingPreferencesWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseEditingPreferencesWebviewMessageWithType(input, inspection.type),
	};
}

export function admitEditingPreferencesHostMessage(
	input: unknown,
): EditingPreferencesAdmissionResult<EditingPreferencesHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseEditingPreferencesHostMessageWithType(input, inspection.type),
	};
}

export function parseEditingPreferencesWebviewMessage(
	input: unknown,
): EditingPreferencesParseResult<EditingPreferencesWebviewMessage> {
	const admission = admitEditingPreferencesWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown editing preferences request type.');
}

export function parseEditingPreferencesHostMessage(
	input: unknown,
): EditingPreferencesParseResult<EditingPreferencesHostMessage> {
	const admission = admitEditingPreferencesHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown editing preferences delivery type.');
}