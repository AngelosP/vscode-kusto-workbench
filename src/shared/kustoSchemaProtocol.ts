import type { KustoEditorLifecycleIdentity } from './kustoSchemaLifecycle';

type UnknownRecord = Record<string, unknown>;

export type KustoSchemaParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoSupplementalRequestSource = 'background' | 'autocomplete';

export type KustoSupplementalFailureKind =
	| 'missing-connection'
	| 'ambiguous-connection'
	| 'auth-required'
	| 'not-found'
	| 'fetch-failed'
	| 'invalid-schema';

export type KustoSchemaFunctionParameter = {
	name: string;
	type?: string;
	defaultValue?: unknown;
	raw?: string;
};

export type KustoSchemaFunction = {
	name: string;
	parametersText?: string;
	parameters?: KustoSchemaFunctionParameter[];
	docString?: string;
	folder?: string;
	body?: string;
};

export type KustoSchemaPayload = {
	tables: string[];
	columnTypesByTable: Record<string, Record<string, string>>;
	tableDocStrings?: Record<string, string>;
	tableFolders?: Record<string, string>;
	columnDocStrings?: Record<string, string>;
	functions?: Array<KustoSchemaFunction | string>;
	rawSchemaJson?: unknown;
};

export type KustoSchemaMetadata = {
	tablesCount?: number;
	columnsCount?: number;
	functionsCount?: number;
	fromCache?: boolean;
	schemaSignature?: string;
	cacheAgeMs?: number;
	debug?: unknown;
	forceRefresh?: boolean;
	deliveryKind?: 'cache-only' | 'cache' | 'memory-cache' | 'cache-failover' | 'fresh';
	cacheState?: 'fresh' | 'stale' | 'outdated';
	isStale?: boolean;
	isBackgroundRefresh?: boolean;
	refreshState?: 'none' | 'scheduled' | 'completed' | 'failed';
	refreshReason?: string;
	workerUpdateNeeded?: boolean;
	autocompleteChanged?: boolean;
	rawCapabilityImproved?: boolean;
	silent?: boolean;
	cacheOnly?: boolean;
	isFailoverToCache?: boolean;
	hasRawSchemaJson?: boolean;
};

export type KustoSchemaPrefetchRequest = Readonly<{
	type: 'prefetchSchema';
	connectionId: string;
	database: string;
	boxId: string;
	forceRefresh?: boolean;
	requestToken?: string;
	cacheOnly?: boolean;
	silent?: boolean;
	reason?: string;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoCrossClusterSchemaRequest = Readonly<{
	type: 'requestCrossClusterSchema';
	clusterName: string;
	database: string;
	boxId: string;
	requestToken: string;
	requestSource: KustoSupplementalRequestSource;
	traceId?: string;
}>;

export type KustoSchemaWebviewMessage =
	| KustoSchemaPrefetchRequest
	| KustoCrossClusterSchemaRequest;

export type KustoSchemaData = Readonly<{
	type: 'schemaData';
	boxId: string;
	connectionId: string;
	database: string;
	clusterUrl: string;
	accountPartition: string;
	requestToken?: string;
	schema: KustoSchemaPayload;
	schemaMeta?: KustoSchemaMetadata;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoSchemaError = Readonly<{
	type: 'schemaError';
	boxId: string;
	connectionId: string;
	database: string;
	requestToken?: string;
	cacheOnly?: boolean;
	silent?: boolean;
	isBackgroundRefresh?: boolean;
	refreshState?: 'failed';
	hasUsableFallback?: boolean;
	error: string;
}> & Partial<KustoEditorLifecycleIdentity>;

export type KustoCrossClusterSchemaData = Readonly<{
	type: 'crossClusterSchemaData';
	clusterName: string;
	clusterUrl: string;
	connectionId?: string;
	accountPartition?: string;
	database: string;
	boxId: string;
	requestToken: string;
	requestSource: KustoSupplementalRequestSource;
	deliverySource: string;
	cacheAgeMs?: number;
	rawSchemaJson: unknown;
}>;

export type KustoCrossClusterSchemaError = Readonly<{
	type: 'crossClusterSchemaError';
	clusterName: string;
	database: string;
	boxId: string;
	requestToken: string;
	requestSource: KustoSupplementalRequestSource;
	failureKind: KustoSupplementalFailureKind;
	error: string;
}>;

export type KustoSchemaHostMessage =
	| KustoSchemaData
	| KustoSchemaError
	| KustoCrossClusterSchemaData
	| KustoCrossClusterSchemaError;

const webviewMessageTypes = new Set([
	'prefetchSchema',
	'requestCrossClusterSchema',
]);

const hostMessageTypes = new Set([
	'schemaData',
	'schemaError',
	'crossClusterSchemaData',
	'crossClusterSchemaError',
]);

const supplementalFailureKinds = new Set<KustoSupplementalFailureKind>([
	'missing-connection',
	'ambiguous-connection',
	'auth-required',
	'not-found',
	'fetch-failed',
	'invalid-schema',
]);

function failure<T>(error: string): KustoSchemaParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
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

function optionalFiniteNumber(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && !isFiniteNumber(input[key])
		? `${key} must be a finite number when present.`
		: undefined;
}

function optionalCount(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && !isRevision(input[key])
		? `${key} must be a non-negative safe integer when present.`
		: undefined;
}

function validateLifecycle(input: UnknownRecord): string | undefined {
	const sectionError = optionalString(input, 'sectionInstanceId');
	if (sectionError) return sectionError;
	return input.targetGeneration !== undefined && !isRevision(input.targetGeneration)
		? 'targetGeneration must be a non-negative safe integer when present.'
		: undefined;
}

function validateStringRecord(input: unknown, label: string): string | undefined {
	if (!isRecord(input)) return `${label} must be an object.`;
	return Object.values(input).some(value => typeof value !== 'string')
		? `${label} values must be strings.`
		: undefined;
}

function validateColumnTypes(input: unknown): string | undefined {
	if (!isRecord(input)) return 'schema.columnTypesByTable must be an object.';
	for (const [table, columns] of Object.entries(input)) {
		const error = validateStringRecord(columns, `schema.columnTypesByTable.${table}`);
		if (error) return error;
	}
	return undefined;
}

function validateFunctionParameter(input: unknown): string | undefined {
	if (!isRecord(input)) return 'Schema function parameters must be objects.';
	const nameError = requiredString(input, 'name');
	if (nameError) return `Schema function parameter ${nameError}`;
	for (const key of ['type', 'raw'] as const) {
		const error = optionalString(input, key);
		if (error) return `Schema function parameter ${error}`;
	}
	return undefined;
}

function validateFunction(input: unknown): string | undefined {
	if (typeof input === 'string') return undefined;
	if (!isRecord(input)) return 'Schema functions must be objects.';
	const nameError = requiredString(input, 'name');
	if (nameError) return `Schema function ${nameError}`;
	for (const key of ['parametersText', 'docString', 'folder', 'body'] as const) {
		const error = optionalString(input, key);
		if (error) return `Schema function ${error}`;
	}
	if (input.parameters !== undefined) {
		if (!Array.isArray(input.parameters)) return 'Schema function parameters must be an array when present.';
		for (const parameter of input.parameters) {
			const error = validateFunctionParameter(parameter);
			if (error) return error;
		}
	}
	return undefined;
}

function validateSchemaPayload(input: unknown): string | undefined {
	if (!isRecord(input)) return 'schema must be an object.';
	if (!Array.isArray(input.tables) || input.tables.some(table => typeof table !== 'string')) {
		return 'schema.tables must be an array of strings.';
	}
	const columnsError = validateColumnTypes(input.columnTypesByTable);
	if (columnsError) return columnsError;
	for (const key of ['tableDocStrings', 'tableFolders', 'columnDocStrings'] as const) {
		if (input[key] === undefined) continue;
		const error = validateStringRecord(input[key], `schema.${key}`);
		if (error) return error;
	}
	if (input.functions !== undefined) {
		if (!Array.isArray(input.functions)) return 'schema.functions must be an array when present.';
		for (const schemaFunction of input.functions) {
			const error = validateFunction(schemaFunction);
			if (error) return error;
		}
	}
	return undefined;
}

function validateSchemaMetadata(input: unknown): string | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input)) return 'schemaMeta must be an object when present.';
	for (const key of ['tablesCount', 'columnsCount', 'functionsCount'] as const) {
		const error = optionalCount(input, key);
		if (error) return `schemaMeta.${error}`;
	}
	const cacheAgeError = optionalFiniteNumber(input, 'cacheAgeMs');
	if (cacheAgeError) return `schemaMeta.${cacheAgeError}`;
	for (const key of [
		'fromCache', 'forceRefresh', 'isStale', 'isBackgroundRefresh', 'workerUpdateNeeded',
		'autocompleteChanged', 'rawCapabilityImproved', 'silent', 'cacheOnly', 'isFailoverToCache',
		'hasRawSchemaJson',
	] as const) {
		const error = optionalBoolean(input, key);
		if (error) return `schemaMeta.${error}`;
	}
	for (const key of ['schemaSignature', 'refreshReason'] as const) {
		const error = optionalString(input, key);
		if (error) return `schemaMeta.${error}`;
	}
	if (input.deliveryKind !== undefined
		&& (typeof input.deliveryKind !== 'string'
			|| !['cache-only', 'cache', 'memory-cache', 'cache-failover', 'fresh'].includes(input.deliveryKind))) {
		return 'schemaMeta.deliveryKind is invalid.';
	}
	if (input.cacheState !== undefined
		&& (typeof input.cacheState !== 'string' || !['fresh', 'stale', 'outdated'].includes(input.cacheState))) {
		return 'schemaMeta.cacheState is invalid.';
	}
	if (input.refreshState !== undefined
		&& (typeof input.refreshState !== 'string'
			|| !['none', 'scheduled', 'completed', 'failed'].includes(input.refreshState))) {
		return 'schemaMeta.refreshState is invalid.';
	}
	return undefined;
}

function validateRequestSource(input: UnknownRecord): string | undefined {
	return input.requestSource === 'background' || input.requestSource === 'autocomplete'
		? undefined
		: 'requestSource must be "background" or "autocomplete".';
}

function validateRequiredStrings(input: UnknownRecord, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const error = requiredString(input, key);
		if (error) return error;
	}
	return undefined;
}

export function isKustoSchemaWebviewMessageType(input: unknown): boolean {
	return isRecord(input) && webviewMessageTypes.has(String(input.type ?? ''));
}

export function isKustoSchemaHostMessageType(input: unknown): boolean {
	return isRecord(input) && hostMessageTypes.has(String(input.type ?? ''));
}

export function parseKustoSchemaWebviewMessage(
	input: unknown,
): KustoSchemaParseResult<KustoSchemaWebviewMessage> {
	if (!isRecord(input)) return failure('Kusto schema request must be an object.');
	if (input.type === 'prefetchSchema') {
		const requiredError = validateRequiredStrings(input, ['connectionId', 'database', 'boxId']);
		if (requiredError) return failure(requiredError);
		for (const key of ['forceRefresh', 'cacheOnly', 'silent'] as const) {
			const error = optionalBoolean(input, key);
			if (error) return failure(error);
		}
		for (const key of ['requestToken', 'reason'] as const) {
			const error = optionalString(input, key);
			if (error) return failure(error);
		}
		const lifecycleError = validateLifecycle(input);
		if (lifecycleError) return failure(lifecycleError);
		return { ok: true, value: input as unknown as KustoSchemaPrefetchRequest };
	}
	if (input.type === 'requestCrossClusterSchema') {
		const requiredError = validateRequiredStrings(input, [
			'clusterName', 'database', 'boxId', 'requestToken',
		]);
		if (requiredError) return failure(requiredError);
		const requestSourceError = validateRequestSource(input);
		if (requestSourceError) return failure(requestSourceError);
		const traceError = optionalString(input, 'traceId');
		if (traceError) return failure(traceError);
		return { ok: true, value: input as unknown as KustoCrossClusterSchemaRequest };
	}
	return failure('Unknown Kusto schema request type.');
}

export function parseKustoSchemaHostMessage(
	input: unknown,
): KustoSchemaParseResult<KustoSchemaHostMessage> {
	if (!isRecord(input)) return failure('Kusto schema delivery must be an object.');
	if (input.type === 'schemaData') {
		const requiredError = validateRequiredStrings(input, [
			'boxId', 'connectionId', 'database', 'clusterUrl', 'accountPartition',
		]);
		if (requiredError) return failure(requiredError);
		const requestTokenError = optionalString(input, 'requestToken');
		if (requestTokenError) return failure(requestTokenError);
		const lifecycleError = validateLifecycle(input);
		if (lifecycleError) return failure(lifecycleError);
		const schemaError = validateSchemaPayload(input.schema);
		if (schemaError) return failure(schemaError);
		const metadataError = validateSchemaMetadata(input.schemaMeta);
		if (metadataError) return failure(metadataError);
		return { ok: true, value: input as unknown as KustoSchemaData };
	}
	if (input.type === 'schemaError') {
		const requiredError = validateRequiredStrings(input, ['boxId', 'connectionId', 'database', 'error']);
		if (requiredError) return failure(requiredError);
		const requestTokenError = optionalString(input, 'requestToken');
		if (requestTokenError) return failure(requestTokenError);
		const lifecycleError = validateLifecycle(input);
		if (lifecycleError) return failure(lifecycleError);
		for (const key of ['cacheOnly', 'silent', 'isBackgroundRefresh', 'hasUsableFallback'] as const) {
			const error = optionalBoolean(input, key);
			if (error) return failure(error);
		}
		if (input.refreshState !== undefined && input.refreshState !== 'failed') {
			return failure('schemaError.refreshState must be "failed" when present.');
		}
		return { ok: true, value: input as unknown as KustoSchemaError };
	}
	if (input.type === 'crossClusterSchemaData') {
		const requiredError = validateRequiredStrings(input, [
			'clusterName', 'clusterUrl', 'database', 'boxId', 'requestToken', 'deliverySource',
		]);
		if (requiredError) return failure(requiredError);
		for (const key of ['connectionId', 'accountPartition'] as const) {
			const error = optionalString(input, key);
			if (error) return failure(error);
		}
		const requestSourceError = validateRequestSource(input);
		if (requestSourceError) return failure(requestSourceError);
		const cacheAgeError = optionalFiniteNumber(input, 'cacheAgeMs');
		if (cacheAgeError) return failure(cacheAgeError);
		if (input.rawSchemaJson === undefined) return failure('rawSchemaJson must be present.');
		return { ok: true, value: input as unknown as KustoCrossClusterSchemaData };
	}
	if (input.type === 'crossClusterSchemaError') {
		const requiredError = validateRequiredStrings(input, [
			'clusterName', 'database', 'boxId', 'requestToken', 'error',
		]);
		if (requiredError) return failure(requiredError);
		const requestSourceError = validateRequestSource(input);
		if (requestSourceError) return failure(requestSourceError);
		if (!supplementalFailureKinds.has(input.failureKind as KustoSupplementalFailureKind)) {
			return failure('failureKind is invalid.');
		}
		return { ok: true, value: input as unknown as KustoCrossClusterSchemaError };
	}
	return failure('Unknown Kusto schema delivery type.');
}
