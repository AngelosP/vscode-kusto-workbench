type UnknownRecord = Record<string, unknown>;

export type SqlDatabaseDiscoveryParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type SqlGetDatabasesRequest = Readonly<{
	type: 'getSqlDatabases';
	sqlConnectionId: string;
	boxId: string;
	sectionInstanceId: string;
	targetGeneration: number;
}>;

export type SqlRefreshDatabasesRequest = Readonly<{
	type: 'refreshSqlDatabases';
	sqlConnectionId: string;
	boxId: string;
	sectionInstanceId: string;
	targetGeneration: number;
}>;

export type SqlDatabaseDiscoveryWebviewMessage =
	| SqlGetDatabasesRequest
	| SqlRefreshDatabasesRequest;

export type SqlDatabaseDiscoveryDeliveryIdentity = Readonly<{
	requestId: string;
	targetGeneration: number;
	boxId: string;
	sectionInstanceId: string;
	sqlConnectionId: string;
}>;

export type SqlDatabasesLoading = SqlDatabaseDiscoveryDeliveryIdentity & Readonly<{
	type: 'sqlDatabasesLoading';
}>;

export type SqlDatabasesData = SqlDatabaseDiscoveryDeliveryIdentity & Readonly<{
	type: 'sqlDatabasesData';
	databases: string[];
}>;

export type SqlDatabasesError = SqlDatabaseDiscoveryDeliveryIdentity & Readonly<{
	type: 'sqlDatabasesError';
	error: string;
}>;

export type SqlDatabaseDiscoveryHostMessage =
	| SqlDatabasesLoading
	| SqlDatabasesData
	| SqlDatabasesError;

const webviewMessageTypes = new Set([
	'getSqlDatabases',
	'refreshSqlDatabases',
]);

const hostMessageTypes = new Set([
	'sqlDatabasesLoading',
	'sqlDatabasesData',
	'sqlDatabasesError',
]);

function failure<T>(error: string): SqlDatabaseDiscoveryParseResult<T> {
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

function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateRequiredStrings(input: UnknownRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		if (typeof input[key] !== 'string') return `${key} must be a string.`;
	}
	return undefined;
}

function validateDeliveryIdentity(input: UnknownRecord): string | undefined {
	const requiredError = validateRequiredStrings(input, [
		'requestId',
		'boxId',
		'sectionInstanceId',
		'sqlConnectionId',
	]);
	if (requiredError) return requiredError;
	return isGeneration(input.targetGeneration)
		? undefined
		: 'targetGeneration must be a non-negative safe integer.';
}

export function isSqlDatabaseDiscoveryWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isSqlDatabaseDiscoveryHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseSqlDatabaseDiscoveryWebviewMessage(
	input: unknown,
): SqlDatabaseDiscoveryParseResult<SqlDatabaseDiscoveryWebviewMessage> {
	if (!isRecord(input)) return failure('SQL database discovery request must be an object.');
	if (input.type !== 'getSqlDatabases' && input.type !== 'refreshSqlDatabases') {
		return failure('Unknown SQL database discovery request type.');
	}
	const requiredError = validateRequiredStrings(input, [
		'sqlConnectionId',
		'boxId',
		'sectionInstanceId',
	]);
	if (requiredError) return failure(requiredError);
	if (!isGeneration(input.targetGeneration)) {
		return failure('targetGeneration must be a non-negative safe integer.');
	}
	return { ok: true, value: input as unknown as SqlDatabaseDiscoveryWebviewMessage };
}

export function parseSqlDatabaseDiscoveryHostMessage(
	input: unknown,
): SqlDatabaseDiscoveryParseResult<SqlDatabaseDiscoveryHostMessage> {
	if (!isRecord(input)) return failure('SQL database discovery delivery must be an object.');
	if (input.type !== 'sqlDatabasesLoading'
		&& input.type !== 'sqlDatabasesData'
		&& input.type !== 'sqlDatabasesError') {
		return failure('Unknown SQL database discovery delivery type.');
	}
	const identityError = validateDeliveryIdentity(input);
	if (identityError) return failure(identityError);
	if (input.type === 'sqlDatabasesData') {
		if (!Array.isArray(input.databases)) {
			return failure('databases must be an array of strings.');
		}
		for (let index = 0; index < input.databases.length; index++) {
			if (!Object.prototype.hasOwnProperty.call(input.databases, index)
				|| typeof input.databases[index] !== 'string') {
				return failure('databases must be an array of strings.');
			}
		}
		return { ok: true, value: input as unknown as SqlDatabasesData };
	}
	if (input.type === 'sqlDatabasesError' && typeof input.error !== 'string') {
		return failure('error must be a string.');
	}
	return { ok: true, value: input as SqlDatabasesLoading | SqlDatabasesError };
}