type UnknownRecord = Record<string, unknown>;

export type KqlLanguageParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KqlPosition = {
	line: number;
	character: number;
};

export type KqlRange = {
	start: KqlPosition;
	end: KqlPosition;
};

export enum KqlDiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export type KqlDiagnostic = {
	range: KqlRange;
	severity: KqlDiagnosticSeverity;
	message: string;
	code?: string;
	source?: string;
};

export type KqlGetDiagnosticsParams = {
	text: string;
	connectionId?: string;
	database?: string;
	boxId?: string;
	uri?: string;
};

export type KqlGetDiagnosticsResult = {
	diagnostics: KqlDiagnostic[];
};

export type KqlTableReference = {
	name: string;
	startOffset: number;
	endOffset: number;
};

export type KqlFindTableReferencesParams = {
	text: string;
	connectionId?: string;
	database?: string;
	boxId?: string;
	uri?: string;
};

export type KqlFindTableReferencesResult = {
	references: KqlTableReference[];
};

export type KqlLanguageMethod = 'textDocument/diagnostic' | 'kusto/findTableReferences';

export type KqlLanguageRequestMessage =
	| {
			type: 'kqlLanguageRequest';
			requestId: string;
			method: 'textDocument/diagnostic';
			params: KqlGetDiagnosticsParams;
	  }
	| {
			type: 'kqlLanguageRequest';
			requestId: string;
			method: 'kusto/findTableReferences';
			params: KqlFindTableReferencesParams;
	  };

export type KqlLanguageResponseMessage =
	| {
			type: 'kqlLanguageResponse';
			requestId: string;
			ok: true;
			result: KqlGetDiagnosticsResult | KqlFindTableReferencesResult;
	  }
	| {
			type: 'kqlLanguageResponse';
			requestId: string;
			ok: false;
			error: { message: string };
	  };

export type KqlLanguageWebviewMessage = KqlLanguageRequestMessage;
export type KqlLanguageHostMessage = KqlLanguageResponseMessage;

const webviewMessageTypes = new Set(['kqlLanguageRequest']);
const hostMessageTypes = new Set(['kqlLanguageResponse']);

function failure<T>(error: string): KqlLanguageParseResult<T> {
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

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateOptionalStrings(input: UnknownRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		if (input[key] !== undefined && typeof input[key] !== 'string') {
			return `${key} must be a string when present.`;
		}
	}
	return undefined;
}

function validateParams(input: unknown): string | undefined {
	if (!isRecord(input)) return 'params must be an object.';
	if (typeof input.text !== 'string') return 'params.text must be a string.';
	return validateOptionalStrings(input, ['connectionId', 'database', 'boxId', 'uri']);
}

function validatePosition(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	if (!isNonNegativeInteger(input.line)) return `${label}.line must be a non-negative safe integer.`;
	if (!isNonNegativeInteger(input.character)) {
		return `${label}.character must be a non-negative safe integer.`;
	}
	return undefined;
}

function validateRange(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	return validatePosition(input.start, `${label}.start`)
		?? validatePosition(input.end, `${label}.end`);
}

function validateDiagnostic(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	const rangeError = validateRange(input.range, `${label}.range`);
	if (rangeError) return rangeError;
	if (!Number.isSafeInteger(input.severity)
		|| Number(input.severity) < KqlDiagnosticSeverity.Error
		|| Number(input.severity) > KqlDiagnosticSeverity.Hint) {
		return `${label}.severity must be a KQL diagnostic severity.`;
	}
	if (typeof input.message !== 'string') return `${label}.message must be a string.`;
	return validateOptionalStrings(input, ['code', 'source']);
}

function validateTableReference(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	if (typeof input.name !== 'string') return `${label}.name must be a string.`;
	if (!isNonNegativeInteger(input.startOffset)) {
		return `${label}.startOffset must be a non-negative safe integer.`;
	}
	if (!isNonNegativeInteger(input.endOffset)) {
		return `${label}.endOffset must be a non-negative safe integer.`;
	}
	return undefined;
}

function validateDenseArray(
	input: unknown,
	label: string,
	validateEntry: (entry: unknown, entryLabel: string) => string | undefined,
): string | undefined {
	if (!Array.isArray(input)) return `${label} must be an array.`;
	for (let index = 0; index < input.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(input, index)) {
			return `${label} must be a dense array.`;
		}
		const error = validateEntry(input[index], `${label}[${index}]`);
		if (error) return error;
	}
	return undefined;
}

function responseResultKind(input: UnknownRecord): KqlLanguageMethod | undefined {
	const hasDiagnostics = Object.prototype.hasOwnProperty.call(input, 'diagnostics');
	const hasReferences = Object.prototype.hasOwnProperty.call(input, 'references');
	if (hasDiagnostics === hasReferences) return undefined;
	return hasDiagnostics ? 'textDocument/diagnostic' : 'kusto/findTableReferences';
}

export function isKqlLanguageWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isKqlLanguageHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseKqlLanguageWebviewMessage(
	input: unknown,
): KqlLanguageParseResult<KqlLanguageWebviewMessage> {
	if (!isRecord(input)) return failure('KQL language request must be an object.');
	if (input.type !== 'kqlLanguageRequest') return failure('Unknown KQL language request type.');
	if (typeof input.requestId !== 'string') return failure('requestId must be a string.');
	if (!input.requestId.trim()) return failure('requestId must not be blank.');
	if (input.method !== 'textDocument/diagnostic' && input.method !== 'kusto/findTableReferences') {
		return failure('Unknown KQL language request method.');
	}
	const paramsError = validateParams(input.params);
	if (paramsError) return failure(paramsError);
	return { ok: true, value: input as unknown as KqlLanguageWebviewMessage };
}

export function parseKqlLanguageHostMessage(
	input: unknown,
): KqlLanguageParseResult<KqlLanguageHostMessage> {
	if (!isRecord(input)) return failure('KQL language response must be an object.');
	if (input.type !== 'kqlLanguageResponse') return failure('Unknown KQL language response type.');
	if (typeof input.requestId !== 'string') return failure('requestId must be a string.');
	if (!input.requestId.trim()) return failure('requestId must not be blank.');

	if (input.ok === false) {
		if (!isRecord(input.error) || typeof input.error.message !== 'string') {
			return failure('error.message must be a string for a failed response.');
		}
		if (input.result !== undefined) return failure('result is invalid for a failed response.');
		return { ok: true, value: input as unknown as KqlLanguageHostMessage };
	}

	if (input.ok !== true) return failure('ok must be a boolean.');
	if (input.error !== undefined) return failure('error is invalid for a successful response.');
	if (!isRecord(input.result)) return failure('result must be an object for a successful response.');
	const resultKind = responseResultKind(input.result);
	if (!resultKind) return failure('result must contain exactly one supported result array.');
	const resultError = resultKind === 'textDocument/diagnostic'
		? validateDenseArray(input.result.diagnostics, 'result.diagnostics', validateDiagnostic)
		: validateDenseArray(input.result.references, 'result.references', validateTableReference);
	if (resultError) return failure(resultError);
	return { ok: true, value: input as unknown as KqlLanguageHostMessage };
}

export function isKqlLanguageResponseForMethod(
	response: KqlLanguageHostMessage,
	method: KqlLanguageMethod,
): boolean {
	return !response.ok || responseResultKind(response.result as UnknownRecord) === method;
}
