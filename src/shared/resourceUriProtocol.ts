type UnknownRecord = Record<string, unknown>;

export type ResourceUriParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type ResourceUriRequestMessage = {
	type: 'resolveResourceUri';
	requestId: string;
	path: string;
	baseUri?: string;
};

export type ResourceUriResultMessage =
	| {
			type: 'resolveResourceUriResult';
			requestId: string;
			ok: true;
			uri: string;
	  }
	| {
			type: 'resolveResourceUriResult';
			requestId: string;
			ok: false;
			error: string;
	  };

export type ResourceUriWebviewMessage = ResourceUriRequestMessage;
export type ResourceUriHostMessage = ResourceUriResultMessage;

const webviewMessageTypes = new Set(['resolveResourceUri']);
const hostMessageTypes = new Set(['resolveResourceUriResult']);

function failure<T>(error: string): ResourceUriParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasKnownType(input: unknown, types: ReadonlySet<string>): boolean {
	if (!input || typeof input !== 'object') return false;
	try {
		return types.has(String((input as UnknownRecord).type ?? ''));
	} catch {
		return false;
	}
}

function validateString(input: UnknownRecord, key: string): string | undefined {
	return typeof input[key] === 'string' ? undefined : `${key} must be a string.`;
}

function validateNonblankString(input: UnknownRecord, key: string): string | undefined {
	const stringError = validateString(input, key);
	if (stringError) return stringError;
	return (input[key] as string).trim() ? undefined : `${key} must not be blank.`;
}

export function isResourceUriWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isResourceUriHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseResourceUriWebviewMessage(
	input: unknown,
): ResourceUriParseResult<ResourceUriWebviewMessage> {
	if (!isRecord(input)) return failure('Resource URI request must be an object.');
	if (input.type !== 'resolveResourceUri') return failure('Unknown resource URI request type.');
	const identityError = validateNonblankString(input, 'requestId') ?? validateString(input, 'path');
	if (identityError) return failure(identityError);
	if (input.baseUri !== undefined && typeof input.baseUri !== 'string') {
		return failure('baseUri must be a string when provided.');
	}
	return { ok: true, value: input as unknown as ResourceUriWebviewMessage };
}

export function parseResourceUriHostMessage(
	input: unknown,
): ResourceUriParseResult<ResourceUriHostMessage> {
	if (!isRecord(input)) return failure('Resource URI result must be an object.');
	if (input.type !== 'resolveResourceUriResult') return failure('Unknown resource URI result type.');
	const identityError = validateNonblankString(input, 'requestId');
	if (identityError) return failure(identityError);
	if (typeof input.ok !== 'boolean') return failure('ok must be a boolean.');
	if (input.ok) {
		if (typeof input.uri !== 'string') return failure('Successful results must contain a string uri.');
		if (input.error !== undefined) return failure('Successful results must not contain an error.');
	} else {
		if (typeof input.error !== 'string') return failure('Failed results must contain a string error.');
		if (input.uri !== undefined) return failure('Failed results must not contain a uri.');
	}
	return { ok: true, value: input as unknown as ResourceUriHostMessage };
}
