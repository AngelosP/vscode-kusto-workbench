type UnknownRecord = Record<string, unknown>;

export type CopilotInlineCompletionParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type CopilotInlineCompletionAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: CopilotInlineCompletionParseResult<T> }>;

type FieldParseResult<T> = CopilotInlineCompletionParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type RequestCopilotInlineCompletionMessage = {
	type: 'requestCopilotInlineCompletion';
	requestId: string;
	boxId: string;
	textBefore: string;
	textAfter: string;
	flavor?: 'kusto' | 'sql';
	ownerToken?: string;
};

export type CopilotInlineCompletion = {
	insertText: string;
};

export type CopilotInlineCompletionResultMessage = {
	type: 'copilotInlineCompletionResult';
	requestId: string;
	boxId: string;
	completions: CopilotInlineCompletion[];
	ownerToken?: string;
	error?: string;
};

export type CopilotInlineCompletionWebviewMessage = RequestCopilotInlineCompletionMessage;
export type CopilotInlineCompletionHostMessage = CopilotInlineCompletionResultMessage;

const webviewMessageTypes = new Set(['requestCopilotInlineCompletion']);
const hostMessageTypes = new Set(['copilotInlineCompletionResult']);

function failure<T>(error: string): CopilotInlineCompletionParseResult<T> {
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

function validateCanonicalRecordPrototype(input: UnknownRecord, label: string): string | undefined {
	try {
		const prototype = Object.getPrototypeOf(input);
		return prototype === Object.prototype || prototype === null
			? undefined
			: `${label} must use a canonical object prototype.`;
	} catch {
		return `${label} prototype could not be inspected.`;
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

function readString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'string'
		? { ok: true, value: field.value }
		: failure(`${key} must be a string.`);
}

function readOptionalString(input: UnknownRecord, key: string): FieldParseResult<string | undefined> {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(input, key);
	} catch {
		return failure(`${key} could not be inspected.`);
	}
	if (!descriptor) {
		try {
			let owner = Object.getPrototypeOf(input);
			const seen = new Set<object>();
			let depth = 0;
			while (owner && depth++ < 16) {
				if (seen.has(owner)) return failure(`${key} prototype inspection was cyclic.`);
				seen.add(owner);
				if (Object.getOwnPropertyDescriptor(owner, key)) {
					return failure(`${key} must not be inherited.`);
				}
				owner = Object.getPrototypeOf(owner);
			}
			if (owner) return failure(`${key} prototype inspection exceeded its bound.`);
		} catch {
			return failure(`${key} prototype could not be inspected.`);
		}
		return { ok: true, value: undefined };
	}
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return descriptor.value === undefined || typeof descriptor.value === 'string'
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a string when provided.`);
}

function captureDenseArray(value: unknown, key: string): FieldParseResult<unknown[]> {
	try {
		if (!Array.isArray(value)) return failure(`${key} must be an array.`);
		if (Object.getPrototypeOf(value) !== Array.prototype
			|| Object.getOwnPropertyDescriptor(value, Symbol.iterator)) {
			return failure(`${key} must use the canonical array prototype and iterator.`);
		}
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		if (!lengthDescriptor
			|| !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
			|| typeof lengthDescriptor.value !== 'number'
			|| !Number.isSafeInteger(lengthDescriptor.value)
			|| lengthDescriptor.value < 0) {
			return failure(`${key} must have a valid length.`);
		}
		const captured: unknown[] = [];
		for (let index = 0; index < lengthDescriptor.value; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be dense and contain only enumerable data entries.`);
			}
			captured.push(descriptor.value);
		}
		return { ok: true, value: captured };
	} catch {
		return failure(`${key} could not be inspected.`);
	}
}

function readCompletions(input: UnknownRecord): FieldParseResult<CopilotInlineCompletion[]> {
	const field = readOwnEnumerableDataProperty(input, 'completions');
	if (!field.ok) return field;
	const completions = captureDenseArray(field.value, 'completions');
	if (!completions.ok) return completions;
	const captured: CopilotInlineCompletion[] = [];
	for (let index = 0; index < completions.value.length; index++) {
		const completion = completions.value[index];
		if (!isRecord(completion)) return failure(`completions[${index}] must be an object.`);
		try {
			const prototype = Object.getPrototypeOf(completion);
			if (prototype !== Object.prototype && prototype !== null) {
				return failure(`completions[${index}] must use a canonical object prototype.`);
			}
		} catch {
			return failure(`completions[${index}] prototype could not be inspected.`);
		}
		const insertText = readString(completion, 'insertText');
		if (!insertText.ok) return failure(`completions[${index}].${insertText.error}`);
		captured.push({ insertText: insertText.value });
	}
	return { ok: true, value: captured };
}

function parseWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): CopilotInlineCompletionParseResult<CopilotInlineCompletionWebviewMessage> {
	if (!isRecord(input)) return failure('Copilot inline-completion request must be an object.');
	const prototypeError = validateCanonicalRecordPrototype(input, 'Copilot inline-completion request');
	if (prototypeError) return failure(prototypeError);
	if (!type.ok) return failure(type.error);
	if (type.value !== 'requestCopilotInlineCompletion') {
		return failure('Unknown Copilot inline-completion request type.');
	}
	const requestId = readString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);
	const boxId = readString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const textBefore = readString(input, 'textBefore');
	if (!textBefore.ok) return failure(textBefore.error);
	const textAfter = readString(input, 'textAfter');
	if (!textAfter.ok) return failure(textAfter.error);
	const flavor = readOptionalString(input, 'flavor');
	if (!flavor.ok) return failure(flavor.error);
	if (flavor.value !== undefined && flavor.value !== 'kusto' && flavor.value !== 'sql') {
		return failure('flavor must be kusto or sql when provided.');
	}
	const ownerToken = readOptionalString(input, 'ownerToken');
	if (!ownerToken.ok) return failure(ownerToken.error);
	return {
		ok: true,
		value: {
			type: 'requestCopilotInlineCompletion',
			requestId: requestId.value,
			boxId: boxId.value,
			textBefore: textBefore.value,
			textAfter: textAfter.value,
			...(flavor.value !== undefined ? { flavor: flavor.value } : {}),
			...(ownerToken.value !== undefined ? { ownerToken: ownerToken.value } : {}),
		},
	};
}

function parseHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): CopilotInlineCompletionParseResult<CopilotInlineCompletionHostMessage> {
	if (!isRecord(input)) return failure('Copilot inline-completion result must be an object.');
	const prototypeError = validateCanonicalRecordPrototype(input, 'Copilot inline-completion result');
	if (prototypeError) return failure(prototypeError);
	if (!type.ok) return failure(type.error);
	if (type.value !== 'copilotInlineCompletionResult') {
		return failure('Unknown Copilot inline-completion result type.');
	}
	const requestId = readString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);
	const boxId = readString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const completions = readCompletions(input);
	if (!completions.ok) return failure(completions.error);
	const ownerToken = readOptionalString(input, 'ownerToken');
	if (!ownerToken.ok) return failure(ownerToken.error);
	const error = readOptionalString(input, 'error');
	if (!error.ok) return failure(error.error);
	return {
		ok: true,
		value: {
			type: 'copilotInlineCompletionResult',
			requestId: requestId.value,
			boxId: boxId.value,
			completions: completions.value,
			...(ownerToken.value !== undefined ? { ownerToken: ownerToken.value } : {}),
			...(error.value !== undefined ? { error: error.value } : {}),
		},
	};
}

export function isCopilotInlineCompletionWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isCopilotInlineCompletionHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitCopilotInlineCompletionWebviewMessage(
	input: unknown,
): CopilotInlineCompletionAdmissionResult<CopilotInlineCompletionWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseWebviewMessageWithType(input, inspection.type) };
}

export function admitCopilotInlineCompletionHostMessage(
	input: unknown,
): CopilotInlineCompletionAdmissionResult<CopilotInlineCompletionHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseHostMessageWithType(input, inspection.type) };
}

export function parseCopilotInlineCompletionWebviewMessage(
	input: unknown,
): CopilotInlineCompletionParseResult<CopilotInlineCompletionWebviewMessage> {
	const admission = admitCopilotInlineCompletionWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Copilot inline-completion request type.');
}

export function parseCopilotInlineCompletionHostMessage(
	input: unknown,
): CopilotInlineCompletionParseResult<CopilotInlineCompletionHostMessage> {
	const admission = admitCopilotInlineCompletionHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Copilot inline-completion result type.');
}