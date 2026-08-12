type UnknownRecord = Record<string, unknown>;

export type ControlCommandSyntaxParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type ControlCommandSyntaxRequestMessage = {
	type: 'fetchControlCommandSyntax';
	requestId: string;
	commandLower: string;
	href: string;
};

export type ControlCommandSyntaxResultMessage =
	| {
			type: 'controlCommandSyntaxResult';
			requestId: string;
			commandLower: string;
			ok: true;
			syntax: string;
			withArgs: string[];
	  }
	| {
			type: 'controlCommandSyntaxResult';
			requestId: string;
			commandLower: string;
			ok: false;
			syntax: '';
			withArgs: [];
	  };

export type ControlCommandSyntaxWebviewMessage = ControlCommandSyntaxRequestMessage;
export type ControlCommandSyntaxHostMessage = ControlCommandSyntaxResultMessage;

const webviewMessageTypes = new Set(['fetchControlCommandSyntax']);
const hostMessageTypes = new Set(['controlCommandSyntaxResult']);

function failure<T>(error: string): ControlCommandSyntaxParseResult<T> {
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

function validateNonblankString(input: UnknownRecord, key: string): string | undefined {
	if (typeof input[key] !== 'string') return `${key} must be a string.`;
	if (!input[key].trim()) return `${key} must not be blank.`;
	return undefined;
}

function validateDenseStringArray(input: unknown, label: string): string | undefined {
	if (!Array.isArray(input)) return `${label} must be an array.`;
	for (let index = 0; index < input.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(input, index)) {
			return `${label} must be a dense array.`;
		}
		if (typeof input[index] !== 'string') return `${label}[${index}] must be a string.`;
	}
	return undefined;
}

export function isControlCommandSyntaxWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isControlCommandSyntaxHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseControlCommandSyntaxWebviewMessage(
	input: unknown,
): ControlCommandSyntaxParseResult<ControlCommandSyntaxWebviewMessage> {
	if (!isRecord(input)) return failure('Control-command syntax request must be an object.');
	if (input.type !== 'fetchControlCommandSyntax') {
		return failure('Unknown control-command syntax request type.');
	}
	const identityError = validateNonblankString(input, 'requestId')
		?? validateNonblankString(input, 'commandLower')
		?? validateNonblankString(input, 'href');
	if (identityError) return failure(identityError);
	return { ok: true, value: input as unknown as ControlCommandSyntaxWebviewMessage };
}

export function parseControlCommandSyntaxHostMessage(
	input: unknown,
): ControlCommandSyntaxParseResult<ControlCommandSyntaxHostMessage> {
	if (!isRecord(input)) return failure('Control-command syntax result must be an object.');
	if (input.type !== 'controlCommandSyntaxResult') {
		return failure('Unknown control-command syntax result type.');
	}
	const identityError = validateNonblankString(input, 'requestId')
		?? validateNonblankString(input, 'commandLower');
	if (identityError) return failure(identityError);
	if (typeof input.ok !== 'boolean') return failure('ok must be a boolean.');
	if (typeof input.syntax !== 'string') return failure('syntax must be a string.');
	const withArgsError = validateDenseStringArray(input.withArgs, 'withArgs');
	if (withArgsError) return failure(withArgsError);
	if (!input.ok && (input.syntax !== '' || (input.withArgs as string[]).length !== 0)) {
		return failure('Failed results must contain empty syntax and withArgs.');
	}
	return { ok: true, value: input as unknown as ControlCommandSyntaxHostMessage };
}
