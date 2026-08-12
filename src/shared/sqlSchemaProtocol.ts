type UnknownRecord = Record<string, unknown>;

export type SqlSchemaParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type SqlSchemaStoredProcedure = {
	name: string;
	schema?: string;
	parametersText?: string;
	body?: string;
};

export type SqlSchemaPayload = {
	tables: string[];
	views?: string[];
	columnsByTable: Record<string, Record<string, string>>;
	storedProcedures?: SqlSchemaStoredProcedure[];
};

export type SqlSchemaPrefetchRequest = Readonly<{
	type: 'prefetchSqlSchema';
	sqlConnectionId: string;
	database: string;
	boxId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	forceRefresh?: boolean;
}>;

export type SqlSchemaWebviewMessage = SqlSchemaPrefetchRequest;

export type SqlSchemaDeliveryIdentity = Readonly<{
	boxId: string;
	sectionInstanceId: string;
	sqlConnectionId: string;
	database: string;
	targetGeneration: number;
	serverUrl: string;
}>;

export type SqlSchemaSuccessMetadata = Readonly<{
	fromCache: boolean;
	tablesCount: number;
	columnsCount: number;
}>;

export type SqlSchemaErrorMetadata = Readonly<{
	error: true;
	errorMessage: string;
}>;

export type SqlSchemaData = SqlSchemaDeliveryIdentity & Readonly<{
	type: 'sqlSchemaData';
}> & (
	| Readonly<{ schema: SqlSchemaPayload; schemaMeta: SqlSchemaSuccessMetadata }>
	| Readonly<{ schema: null; schemaMeta: SqlSchemaErrorMetadata }>
);

export type SqlSchemaHostMessage = SqlSchemaData;

const webviewMessageTypes = new Set(['prefetchSqlSchema']);
const hostMessageTypes = new Set(['sqlSchemaData']);

function failure<T>(error: string): SqlSchemaParseResult<T> {
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

function requiredString(input: UnknownRecord, key: string): string | undefined {
	return typeof input[key] === 'string' ? undefined : `${key} must be a string.`;
}

function validateRequiredStrings(input: UnknownRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const error = requiredString(input, key);
		if (error) return error;
	}
	return undefined;
}

function validateDenseStringArray(input: unknown, label: string): string | undefined {
	if (!Array.isArray(input)) return `${label} must be an array of strings.`;
	for (let index = 0; index < input.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(input, index) || typeof input[index] !== 'string') {
			return `${label} must be an array of strings.`;
		}
	}
	return undefined;
}

function validateStringRecord(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	return Object.values(input).some(value => typeof value !== 'string')
		? `${label} values must be strings.`
		: undefined;
}

function validateColumnsByTable(input: unknown): string | undefined {
	if (!isRecord(input)) return 'schema.columnsByTable must be an object.';
	for (const [table, columns] of Object.entries(input)) {
		const error = validateStringRecord(columns, `schema.columnsByTable.${table}`);
		if (error) return error;
	}
	return undefined;
}

function validateStoredProcedures(input: unknown): string | undefined {
	if (!Array.isArray(input)) return 'schema.storedProcedures must be an array when present.';
	for (let index = 0; index < input.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(input, index) || !isRecord(input[index])) {
			return 'schema.storedProcedures entries must be objects.';
		}
		const procedure = input[index];
		const nameError = requiredString(procedure, 'name');
		if (nameError) return `schema.storedProcedures ${nameError}`;
		for (const key of ['schema', 'parametersText', 'body'] as const) {
			if (procedure[key] !== undefined && typeof procedure[key] !== 'string') {
				return `schema.storedProcedures ${key} must be a string when present.`;
			}
		}
	}
	return undefined;
}

function validateSchema(input: unknown): string | undefined {
	if (!isRecord(input)) return 'schema must be an object.';
	const tablesError = validateDenseStringArray(input.tables, 'schema.tables');
	if (tablesError) return tablesError;
	if (input.views !== undefined) {
		const viewsError = validateDenseStringArray(input.views, 'schema.views');
		if (viewsError) return viewsError;
	}
	const columnsError = validateColumnsByTable(input.columnsByTable);
	if (columnsError) return columnsError;
	if (input.storedProcedures !== undefined) {
		const proceduresError = validateStoredProcedures(input.storedProcedures);
		if (proceduresError) return proceduresError;
	}
	return undefined;
}

function validateDeliveryIdentity(input: UnknownRecord): string | undefined {
	const requiredError = validateRequiredStrings(input, [
		'boxId',
		'sectionInstanceId',
		'sqlConnectionId',
		'database',
		'serverUrl',
	]);
	if (requiredError) return requiredError;
	return isGeneration(input.targetGeneration)
		? undefined
		: 'targetGeneration must be a non-negative safe integer.';
}

export function isSqlSchemaWebviewMessageType(input: unknown): boolean {
	return hasKnownType(input, webviewMessageTypes);
}

export function isSqlSchemaHostMessageType(input: unknown): boolean {
	return hasKnownType(input, hostMessageTypes);
}

export function parseSqlSchemaWebviewMessage(
	input: unknown,
): SqlSchemaParseResult<SqlSchemaWebviewMessage> {
	if (!isRecord(input)) return failure('SQL schema request must be an object.');
	if (input.type !== 'prefetchSqlSchema') return failure('Unknown SQL schema request type.');
	const requiredError = validateRequiredStrings(input, [
		'sqlConnectionId',
		'database',
		'boxId',
		'sectionInstanceId',
	]);
	if (requiredError) return failure(requiredError);
	if (!isGeneration(input.targetGeneration)) {
		return failure('targetGeneration must be a non-negative safe integer.');
	}
	if (input.forceRefresh !== undefined && typeof input.forceRefresh !== 'boolean') {
		return failure('forceRefresh must be a boolean when present.');
	}
	return { ok: true, value: input as unknown as SqlSchemaWebviewMessage };
}

export function parseSqlSchemaHostMessage(
	input: unknown,
): SqlSchemaParseResult<SqlSchemaHostMessage> {
	if (!isRecord(input)) return failure('SQL schema delivery must be an object.');
	if (input.type !== 'sqlSchemaData') return failure('Unknown SQL schema delivery type.');
	const identityError = validateDeliveryIdentity(input);
	if (identityError) return failure(identityError);
	if (!isRecord(input.schemaMeta)) return failure('schemaMeta must be an object.');

	if (input.schemaMeta.error === true) {
		if (input.schema !== null) return failure('schema must be null for an error delivery.');
		if (typeof input.schemaMeta.errorMessage !== 'string') {
			return failure('schemaMeta.errorMessage must be a string for an error delivery.');
		}
		if (input.schemaMeta.fromCache !== undefined
			|| input.schemaMeta.tablesCount !== undefined
			|| input.schemaMeta.columnsCount !== undefined) {
			return failure('schemaMeta success fields are invalid for an error delivery.');
		}
		return { ok: true, value: input as unknown as SqlSchemaData };
	}

	if (input.schemaMeta.error !== undefined || input.schemaMeta.errorMessage !== undefined) {
		return failure('schemaMeta error fields are invalid for a success delivery.');
	}
	if (typeof input.schemaMeta.fromCache !== 'boolean') {
		return failure('schemaMeta.fromCache must be a boolean for a success delivery.');
	}
	for (const key of ['tablesCount', 'columnsCount'] as const) {
		if (!isGeneration(input.schemaMeta[key])) {
			return failure(`schemaMeta.${key} must be a non-negative safe integer.`);
		}
	}
	const schemaError = validateSchema(input.schema);
	if (schemaError) return failure(schemaError);
	return { ok: true, value: input as unknown as SqlSchemaData };
}
