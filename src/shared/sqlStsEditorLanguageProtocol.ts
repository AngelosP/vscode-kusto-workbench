type UnknownRecord = Record<string, unknown>;

export type SqlStsEditorLanguageParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type SqlStsEditorLanguageAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: SqlStsEditorLanguageParseResult<T> }>;

type FieldParseResult<T> = SqlStsEditorLanguageParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type SqlStsExpectedOwner = Readonly<{
	connectionId: string;
	database: string;
	targetSignature: string;
	principalFingerprint: string;
	revocationGeneration: number;
}>;

export type SqlStsRequestParams = Readonly<{
	boxId: string;
	sectionInstanceId: string;
	line: number;
	column: number;
	ownerToken: string;
	targetGeneration: number;
}>;

export type SqlStsRequestMessage = Readonly<{
	type: 'stsRequest';
	requestId: string;
	method: string;
	params: SqlStsRequestParams;
}>;

export type SqlStsDidOpenMessage = Readonly<{
	type: 'stsDidOpen';
	boxId: string;
	sectionInstanceId: string;
	text: string;
}>;

export type SqlStsDidChangeMessage = Readonly<{
	type: 'stsDidChange';
	boxId: string;
	sectionInstanceId: string;
	text: string;
}>;

export type SqlStsDidCloseMessage = Readonly<{
	type: 'stsDidClose';
	boxId: string;
	sectionInstanceId: string;
}>;

export type SqlStsConnectMessage = Readonly<{
	type: 'stsConnect';
	boxId: string;
	sectionInstanceId: string;
	sqlConnectionId: string;
	database: string;
	targetGeneration: number;
	expectedOwner?: SqlStsExpectedOwner;
}>;

export type SqlStsEditorLanguageWebviewMessage =
	| SqlStsRequestMessage
	| SqlStsDidOpenMessage
	| SqlStsDidChangeMessage
	| SqlStsDidCloseMessage
	| SqlStsConnectMessage;

export type SqlStsResponseMessage = Readonly<{
	type: 'stsResponse';
	boxId: string;
	sectionInstanceId: string;
	requestId: string;
	result: unknown;
	ownerToken: string;
	targetGeneration: number;
}>;

export type SqlStsDiagnosticsMessage = Readonly<{
	type: 'stsDiagnostics';
	boxId: string;
	sectionInstanceId: string;
	markers: object[];
}>;

export type SqlStsConnectionReadyMessage = Readonly<{
	type: 'stsConnectionState';
	boxId: string;
	sectionInstanceId: string;
	state: 'ready';
	ownerToken: string;
	connectionId: string;
	database: string;
	targetGeneration: number;
}>;

export type SqlStsConnectionErrorMessage = Readonly<{
	type: 'stsConnectionState';
	boxId: string;
	sectionInstanceId: string;
	state: 'error';
	error: string;
	targetGeneration?: number;
}>;

export type SqlStsConnectionStateMessage =
	| SqlStsConnectionReadyMessage
	| SqlStsConnectionErrorMessage;

export type SqlStsEditorLanguageHostMessage =
	| SqlStsResponseMessage
	| SqlStsDiagnosticsMessage
	| SqlStsConnectionStateMessage;

const webviewMessageTypes = new Set([
	'stsRequest', 'stsDidOpen', 'stsDidChange', 'stsDidClose', 'stsConnect',
]);
const hostMessageTypes = new Set(['stsResponse', 'stsDiagnostics', 'stsConnectionState']);

function failure<T>(error: string): SqlStsEditorLanguageParseResult<T> {
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
					return { recognized: true, type: failure('type must be an own enumerable data property.') };
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

function readOptionalOwnEnumerableDataProperty(
	input: UnknownRecord,
	key: string,
): FieldParseResult<unknown | undefined> {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor) {
			if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be an own enumerable data property when provided.`);
			}
			return { ok: true, value: descriptor.value };
		}
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
		return { ok: true, value: undefined };
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

function readNonblankString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readString(input, key);
	if (!field.ok) return field;
	return field.value.trim() ? field : failure(`${key} must not be blank.`);
}

function readSafeInteger(
	input: UnknownRecord,
	key: string,
	minimum: number,
): FieldParseResult<number> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'number'
		&& Number.isSafeInteger(field.value)
		&& field.value >= minimum
		? { ok: true, value: field.value }
		: failure(`${key} must be a safe integer greater than or equal to ${minimum}.`);
}

function readOptionalNonnegativeSafeInteger(
	input: UnknownRecord,
	key: string,
): FieldParseResult<number | undefined> {
	const field = readOptionalOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	if (field.value === undefined) return { ok: true, value: undefined };
	return typeof field.value === 'number'
		&& Number.isSafeInteger(field.value)
		&& field.value >= 0
		? { ok: true, value: field.value }
		: failure(`${key} must be a non-negative safe integer when provided.`);
}

function readRecord(input: UnknownRecord, key: string): FieldParseResult<UnknownRecord> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return isRecord(field.value)
		? { ok: true, value: field.value }
		: failure(`${key} must be an object.`);
}

function readExpectedOwner(input: UnknownRecord): FieldParseResult<SqlStsExpectedOwner | undefined> {
	const field = readOptionalOwnEnumerableDataProperty(input, 'expectedOwner');
	if (!field.ok) return field;
	if (field.value === undefined) return { ok: true, value: undefined };
	if (!isRecord(field.value)) return failure('expectedOwner must be an object when provided.');
	const connectionId = readNonblankString(field.value, 'connectionId');
	if (!connectionId.ok) return failure(`expectedOwner.${connectionId.error}`);
	const database = readNonblankString(field.value, 'database');
	if (!database.ok) return failure(`expectedOwner.${database.error}`);
	const targetSignature = readNonblankString(field.value, 'targetSignature');
	if (!targetSignature.ok) return failure(`expectedOwner.${targetSignature.error}`);
	const principalFingerprint = readNonblankString(field.value, 'principalFingerprint');
	if (!principalFingerprint.ok) return failure(`expectedOwner.${principalFingerprint.error}`);
	const revocationGeneration = readSafeInteger(field.value, 'revocationGeneration', 0);
	if (!revocationGeneration.ok) return failure(`expectedOwner.${revocationGeneration.error}`);
	return {
		ok: true,
		value: field.value as SqlStsExpectedOwner,
	};
}

function readDenseOpaqueRecordArray(input: UnknownRecord, key: string): FieldParseResult<object[]> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	let isArray = false;
	try {
		isArray = Array.isArray(field.value);
	} catch {
		return failure(`${key} could not be inspected.`);
	}
	if (!isArray) return failure(`${key} must be an array.`);
	const source = field.value as unknown[];
	let ownKeys: PropertyKey[];
	let length: number;
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(source, 'length');
		if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
			|| typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value)
			|| lengthDescriptor.value < 0) {
			return failure(`${key} must have a canonical array length.`);
		}
		length = lengthDescriptor.value;
		ownKeys = Reflect.ownKeys(source);
	} catch {
		return failure(`${key} could not be inspected.`);
	}
	const indexKeys = ownKeys.filter((candidate): candidate is string => {
		if (typeof candidate !== 'string' || !/^(0|[1-9]\d*)$/.test(candidate)) return false;
		const index = Number(candidate);
		return Number.isSafeInteger(index) && index >= 0 && index < length;
	});
	if (indexKeys.length !== length) {
		return failure(`${key} must be dense and contain own enumerable data entries.`);
	}
	const values: object[] = [];
	for (const indexKey of indexKeys) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(source, indexKey);
		} catch {
			return failure(`${key}[${indexKey}] could not be inspected.`);
		}
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return failure(`${key} must be dense and contain own enumerable data entries.`);
		}
		if (!isRecord(descriptor.value)) return failure(`${key}[${indexKey}] must be an object.`);
		values.push(descriptor.value);
	}
	return { ok: true, value: values };
}

function hasOwn(input: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(input, key);
	} catch {
		return true;
	}
}

function readSectionIdentity(input: UnknownRecord): FieldParseResult<{
	boxId: string;
	sectionInstanceId: string;
}> {
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return boxId;
	const sectionInstanceId = readNonblankString(input, 'sectionInstanceId');
	if (!sectionInstanceId.ok) return sectionInstanceId;
	return { ok: true, value: { boxId: boxId.value, sectionInstanceId: sectionInstanceId.value } };
}

function parseSqlStsEditorLanguageWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): SqlStsEditorLanguageParseResult<SqlStsEditorLanguageWebviewMessage> {
	if (!isRecord(input)) return failure('SQL STS editor-language request must be an object.');
	if (!type.ok) return failure(type.error);

	if (type.value === 'stsRequest') {
		const requestId = readNonblankString(input, 'requestId');
		if (!requestId.ok) return failure(requestId.error);
		const method = readNonblankString(input, 'method');
		if (!method.ok) return failure(method.error);
		const params = readRecord(input, 'params');
		if (!params.ok) return failure(params.error);
		const identity = readSectionIdentity(params.value);
		if (!identity.ok) return failure(`params.${identity.error}`);
		const line = readSafeInteger(params.value, 'line', 1);
		if (!line.ok) return failure(`params.${line.error}`);
		const column = readSafeInteger(params.value, 'column', 1);
		if (!column.ok) return failure(`params.${column.error}`);
		const ownerToken = readNonblankString(params.value, 'ownerToken');
		if (!ownerToken.ok) return failure(`params.${ownerToken.error}`);
		const targetGeneration = readSafeInteger(params.value, 'targetGeneration', 0);
		if (!targetGeneration.ok) return failure(`params.${targetGeneration.error}`);
		return {
			ok: true,
			value: {
				type: 'stsRequest',
				requestId: requestId.value,
				method: method.value,
				params: params.value as SqlStsRequestParams,
			},
		};
	}

	if (type.value === 'stsDidOpen' || type.value === 'stsDidChange') {
		const identity = readSectionIdentity(input);
		if (!identity.ok) return failure(identity.error);
		const text = readString(input, 'text');
		if (!text.ok) return failure(text.error);
		return {
			ok: true,
			value: { type: type.value, ...identity.value, text: text.value },
		};
	}

	if (type.value === 'stsDidClose') {
		const identity = readSectionIdentity(input);
		return identity.ok
			? { ok: true, value: { type: 'stsDidClose', ...identity.value } }
			: failure(identity.error);
	}

	if (type.value === 'stsConnect') {
		const identity = readSectionIdentity(input);
		if (!identity.ok) return failure(identity.error);
		const sqlConnectionId = readNonblankString(input, 'sqlConnectionId');
		if (!sqlConnectionId.ok) return failure(sqlConnectionId.error);
		const database = readNonblankString(input, 'database');
		if (!database.ok) return failure(database.error);
		const targetGeneration = readSafeInteger(input, 'targetGeneration', 0);
		if (!targetGeneration.ok) return failure(targetGeneration.error);
		const expectedOwner = readExpectedOwner(input);
		if (!expectedOwner.ok) return failure(expectedOwner.error);
		return {
			ok: true,
			value: {
				type: 'stsConnect',
				...identity.value,
				sqlConnectionId: sqlConnectionId.value,
				database: database.value,
				targetGeneration: targetGeneration.value,
				...(expectedOwner.value ? { expectedOwner: expectedOwner.value } : {}),
			},
		};
	}

	return failure('Unknown SQL STS editor-language request type.');
}

function parseSqlStsEditorLanguageHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): SqlStsEditorLanguageParseResult<SqlStsEditorLanguageHostMessage> {
	if (!isRecord(input)) return failure('SQL STS editor-language delivery must be an object.');
	if (!type.ok) return failure(type.error);
	const identity = readSectionIdentity(input);
	if (!identity.ok) return failure(identity.error);

	if (type.value === 'stsResponse') {
		const requestId = readNonblankString(input, 'requestId');
		if (!requestId.ok) return failure(requestId.error);
		const result = readOwnEnumerableDataProperty(input, 'result');
		if (!result.ok) return failure(result.error);
		const ownerToken = readNonblankString(input, 'ownerToken');
		if (!ownerToken.ok) return failure(ownerToken.error);
		const targetGeneration = readSafeInteger(input, 'targetGeneration', 0);
		if (!targetGeneration.ok) return failure(targetGeneration.error);
		return {
			ok: true,
			value: {
				type: 'stsResponse',
				...identity.value,
				requestId: requestId.value,
				result: result.value,
				ownerToken: ownerToken.value,
				targetGeneration: targetGeneration.value,
			},
		};
	}

	if (type.value === 'stsDiagnostics') {
		const markers = readDenseOpaqueRecordArray(input, 'markers');
		if (!markers.ok) return failure(markers.error);
		return {
			ok: true,
			value: { type: 'stsDiagnostics', ...identity.value, markers: markers.value },
		};
	}

	if (type.value === 'stsConnectionState') {
		const state = readString(input, 'state');
		if (!state.ok) return failure(state.error);
		if (state.value === 'ready') {
			if (hasOwn(input, 'error')) return failure('Ready STS connection state must not contain error.');
			const ownerToken = readNonblankString(input, 'ownerToken');
			if (!ownerToken.ok) return failure(ownerToken.error);
			const connectionId = readNonblankString(input, 'connectionId');
			if (!connectionId.ok) return failure(connectionId.error);
			const database = readNonblankString(input, 'database');
			if (!database.ok) return failure(database.error);
			const targetGeneration = readSafeInteger(input, 'targetGeneration', 0);
			if (!targetGeneration.ok) return failure(targetGeneration.error);
			return {
				ok: true,
				value: {
					type: 'stsConnectionState',
					...identity.value,
					state: 'ready',
					ownerToken: ownerToken.value,
					connectionId: connectionId.value,
					database: database.value,
					targetGeneration: targetGeneration.value,
				},
			};
		}
		if (state.value === 'error') {
			for (const key of ['ownerToken', 'connectionId', 'database']) {
				if (hasOwn(input, key)) return failure(`Error STS connection state must not contain ${key}.`);
			}
			const error = readString(input, 'error');
			if (!error.ok) return failure(error.error);
			const targetGeneration = readOptionalNonnegativeSafeInteger(input, 'targetGeneration');
			if (!targetGeneration.ok) return failure(targetGeneration.error);
			return {
				ok: true,
				value: {
					type: 'stsConnectionState',
					...identity.value,
					state: 'error',
					error: error.value,
					...(targetGeneration.value === undefined ? {} : { targetGeneration: targetGeneration.value }),
				},
			};
		}
		return failure('state must be ready or error.');
	}

	return failure('Unknown SQL STS editor-language delivery type.');
}

export function isSqlStsEditorLanguageWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isSqlStsEditorLanguageHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitSqlStsEditorLanguageWebviewMessage(
	input: unknown,
): SqlStsEditorLanguageAdmissionResult<SqlStsEditorLanguageWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseSqlStsEditorLanguageWebviewMessageWithType(input, inspection.type),
	};
}

export function admitSqlStsEditorLanguageHostMessage(
	input: unknown,
): SqlStsEditorLanguageAdmissionResult<SqlStsEditorLanguageHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseSqlStsEditorLanguageHostMessageWithType(input, inspection.type),
	};
}

export function parseSqlStsEditorLanguageWebviewMessage(
	input: unknown,
): SqlStsEditorLanguageParseResult<SqlStsEditorLanguageWebviewMessage> {
	const admission = admitSqlStsEditorLanguageWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown SQL STS editor-language request type.');
}

export function parseSqlStsEditorLanguageHostMessage(
	input: unknown,
): SqlStsEditorLanguageParseResult<SqlStsEditorLanguageHostMessage> {
	const admission = admitSqlStsEditorLanguageHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown SQL STS editor-language delivery type.');
}
