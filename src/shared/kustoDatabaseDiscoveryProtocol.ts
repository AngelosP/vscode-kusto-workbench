import type { KustoEditorLifecycleIdentity } from './kustoSchemaLifecycle';

type UnknownRecord = Record<string, unknown>;

export type KustoDatabaseDiscoveryParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoGetDatabasesRequest = Readonly<{
	type: 'getDatabases';
	connectionId: string;
	boxId: string;
	requestToken?: string;
	requiredDatabase?: string;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoRefreshDatabasesRequest = Readonly<{
	type: 'refreshDatabases';
	connectionId: string;
	boxId: string;
	requestToken?: string;
	requiredDatabase?: string;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoDatabaseDiscoveryWebviewMessage =
	| KustoGetDatabasesRequest
	| KustoRefreshDatabasesRequest;

export type KustoDatabasesData = Readonly<{
	type: 'databasesData';
	databases: string[];
	boxId: string;
	connectionId: string;
	accountPartition?: string;
	requestToken?: string;
	authoritative?: boolean;
	fallback?: boolean;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoDatabasesError = Readonly<{
	type: 'databasesError';
	boxId: string;
	connectionId: string;
	error: string;
	requestToken?: string;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoDatabaseDiscoveryHostMessage =
	| KustoDatabasesData
	| KustoDatabasesError;

const webviewMessageTypes = new Set([
	'getDatabases',
	'refreshDatabases',
]);

const hostMessageTypes = new Set([
	'databasesData',
	'databasesError',
]);

function failure<T>(error: string): KustoDatabaseDiscoveryParseResult<T> {
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

function isRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requiredString(input: UnknownRecord, key: string): string | undefined {
	return typeof input[key] === 'string' ? undefined : `${key} must be a string.`;
}

function optionalString(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && typeof input[key] !== 'string'
		? `${key} must be a string when present.`
		: undefined;
}

function optionalBoolean(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && typeof input[key] !== 'boolean'
		? `${key} must be a boolean when present.`
		: undefined;
}

function validateLifecycle(input: UnknownRecord): string | undefined {
	const sectionError = optionalString(input, 'sectionInstanceId');
	if (sectionError) return sectionError;
	return input.targetGeneration !== undefined && !isRevision(input.targetGeneration)
		? 'targetGeneration must be a non-negative safe integer when present.'
		: undefined;
}

function validateRequiredStrings(input: UnknownRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const error = requiredString(input, key);
		if (error) return error;
	}
	return undefined;
}

export function isKustoDatabaseDiscoveryWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isKustoDatabaseDiscoveryHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseKustoDatabaseDiscoveryWebviewMessage(
	input: unknown,
): KustoDatabaseDiscoveryParseResult<KustoDatabaseDiscoveryWebviewMessage> {
	if (!isRecord(input)) return failure('Kusto database discovery request must be an object.');
	if (input.type !== 'getDatabases' && input.type !== 'refreshDatabases') {
		return failure('Unknown Kusto database discovery request type.');
	}
	const requiredError = validateRequiredStrings(input, ['connectionId', 'boxId']);
	if (requiredError) return failure(requiredError);
	for (const key of ['requestToken', 'requiredDatabase'] as const) {
		const error = optionalString(input, key);
		if (error) return failure(error);
	}
	const lifecycleError = validateLifecycle(input);
	if (lifecycleError) return failure(lifecycleError);
	return { ok: true, value: input as unknown as KustoDatabaseDiscoveryWebviewMessage };
}

export function parseKustoDatabaseDiscoveryHostMessage(
	input: unknown,
): KustoDatabaseDiscoveryParseResult<KustoDatabaseDiscoveryHostMessage> {
	if (!isRecord(input)) return failure('Kusto database discovery delivery must be an object.');
	if (input.type === 'databasesData') {
		const requiredError = validateRequiredStrings(input, ['boxId', 'connectionId']);
		if (requiredError) return failure(requiredError);
		if (!Array.isArray(input.databases)) {
			return failure('databases must be an array of strings.');
		}
		for (let index = 0; index < input.databases.length; index++) {
			if (typeof input.databases[index] !== 'string') {
				return failure('databases must be an array of strings.');
			}
		}
		for (const key of ['accountPartition', 'requestToken'] as const) {
			const error = optionalString(input, key);
			if (error) return failure(error);
		}
		for (const key of ['authoritative', 'fallback'] as const) {
			const error = optionalBoolean(input, key);
			if (error) return failure(error);
		}
		const lifecycleError = validateLifecycle(input);
		if (lifecycleError) return failure(lifecycleError);
		return { ok: true, value: input as unknown as KustoDatabasesData };
	}
	if (input.type === 'databasesError') {
		const requiredError = validateRequiredStrings(input, ['boxId', 'connectionId', 'error']);
		if (requiredError) return failure(requiredError);
		const requestTokenError = optionalString(input, 'requestToken');
		if (requestTokenError) return failure(requestTokenError);
		const lifecycleError = validateLifecycle(input);
		if (lifecycleError) return failure(lifecycleError);
		return { ok: true, value: input as unknown as KustoDatabasesError };
	}
	return failure('Unknown Kusto database discovery delivery type.');
}
