type UnknownRecord = Record<string, unknown>;

export type SqlConnectionsProjectionParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type SqlConnectionsProjectionAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: SqlConnectionsProjectionParseResult<T> }>;

type FieldParseResult<T> = SqlConnectionsProjectionParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type SqlConnectionsProjectionRequest = Readonly<{
	type: 'getSqlConnections';
}>;

export type SqlConnectionsProjectionWebviewMessage = SqlConnectionsProjectionRequest;

export type SqlConnectionProjection = Readonly<{
	id: string;
	name: string;
	dialect: string;
	serverUrl: string;
	port?: number;
	database?: string;
	authType: string;
	username?: string;
	credentialRevision?: number;
	principalFingerprint?: string;
	revocationGeneration?: number;
}>;

export type LegacySqlConnectionProjection = Readonly<{
	id: string;
	serverUrl: string;
	name?: string;
	dialect?: string;
	port?: number;
	database?: string;
	authType?: string;
	username?: string;
	credentialRevision?: number;
	principalFingerprint?: string;
	revocationGeneration?: number;
}>;

export type SqlConnectionsProjectionStateVersions = Readonly<{
	policy: number;
	connections: number;
	principals: number;
}>;

export type SqlConnectionsProjectionFavorite = Readonly<{
	name: string;
	connectionId: string;
	database: string;
}>;

export type SqlConnectionsData = Readonly<{
	type: 'sqlConnectionsData';
	revision: number;
	sqlStateVersions: SqlConnectionsProjectionStateVersions;
	connections: SqlConnectionProjection[];
	lastConnectionId: string;
	lastDatabase: string;
	cachedDatabases: Record<string, string[]>;
	sqlFavorites: SqlConnectionsProjectionFavorite[];
	sqlLeaveNoTrace: string[];
}>;

export type LegacySqlConnectionsData = Readonly<{
	type: 'sqlConnectionsData';
	revision?: undefined;
	sqlStateVersions?: SqlConnectionsProjectionStateVersions;
	connections: LegacySqlConnectionProjection[];
	lastConnectionId?: string;
	lastDatabase?: string;
	cachedDatabases?: Record<string, string[]>;
	sqlFavorites?: SqlConnectionsProjectionFavorite[];
	sqlLeaveNoTrace?: string[];
}>;

export type SqlConnectionsProjectionHostMessage = SqlConnectionsData | LegacySqlConnectionsData;

const webviewMessageTypes = new Set(['getSqlConnections']);
const hostMessageTypes = new Set(['sqlConnectionsData']);

function failure<T>(error: string): SqlConnectionsProjectionParseResult<T> {
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
			if (Object.getOwnPropertyDescriptor(owner, key)) return failure(`${key} must not be inherited.`);
			owner = Object.getPrototypeOf(owner);
		}
		if (owner) return failure(`${key} prototype inspection exceeded its bound.`);
		return { ok: true, value: undefined };
	} catch {
		return failure(`${key} could not be inspected.`);
	}
}

function validateString(value: unknown, label: string): string | undefined {
	return typeof value === 'string' ? undefined : `${label} must be a string.`;
}

function validateNonnegativeSafeInteger(value: unknown, label: string): string | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? undefined
		: `${label} must be a non-negative safe integer.`;
}

function validateFiniteNumber(value: unknown, label: string): string | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? undefined
		: `${label} must be a finite number.`;
}

function validateRequiredField(
	input: UnknownRecord,
	key: string,
	validate: (value: unknown, label: string) => string | undefined,
	label: string = key,
): string | undefined {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field.error;
	return validate(field.value, label);
}

function validateOptionalField(
	input: UnknownRecord,
	key: string,
	validate: (value: unknown, label: string) => string | undefined,
	label: string = key,
): string | undefined {
	const field = readOptionalOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field.error;
	return field.value === undefined ? undefined : validate(field.value, label);
}

function validateDenseArray(
	value: unknown,
	label: string,
	validateEntry: (entry: unknown, label: string) => string | undefined,
): string | undefined {
	try {
		if (!Array.isArray(value)) return `${label} must be an array.`;
		if (Object.getPrototypeOf(value) !== Array.prototype
			|| Object.getOwnPropertyDescriptor(value, Symbol.iterator)) {
			return `${label} must use the canonical array prototype and iterator.`;
		}
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		if (!lengthDescriptor
			|| !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
			|| typeof lengthDescriptor.value !== 'number'
			|| !Number.isSafeInteger(lengthDescriptor.value)
			|| lengthDescriptor.value < 0) {
			return `${label} length must be a non-negative safe-integer data property.`;
		}
		const length = lengthDescriptor.value;
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return `${label} must be dense and contain only own enumerable data entries.`;
			}
			const error = validateEntry(descriptor.value, `${label}[${index}]`);
			if (error) return error;
		}
	} catch {
		return `${label} could not be inspected.`;
	}
	return undefined;
}

function validateStringArray(value: unknown, label: string): string | undefined {
	return validateDenseArray(value, label, validateString);
}

function validateConnection(value: unknown, label: string, canonical: boolean): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	for (const key of ['id', 'serverUrl']) {
		const error = validateRequiredField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	for (const key of ['name', 'dialect', 'authType']) {
		const error = canonical
			? validateRequiredField(value, key, validateString, `${label}.${key}`)
			: validateOptionalField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	for (const key of ['database', 'username', 'principalFingerprint']) {
		const error = validateOptionalField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	const portError = validateOptionalField(value, 'port', validateFiniteNumber, `${label}.port`);
	if (portError) return portError;
	for (const key of ['credentialRevision', 'revocationGeneration']) {
		const error = validateOptionalField(value, key, validateNonnegativeSafeInteger, `${label}.${key}`);
		if (error) return error;
	}
	return undefined;
}

function validateConnections(value: unknown, label: string, canonical: boolean): string | undefined {
	return validateDenseArray(value, label, (entry, entryLabel) =>
		validateConnection(entry, entryLabel, canonical));
}

function validateStateVersions(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	for (const key of ['policy', 'connections', 'principals']) {
		const error = validateRequiredField(value, key, validateNonnegativeSafeInteger, `${label}.${key}`);
		if (error) return error;
	}
	return undefined;
}

function validateCachedDatabases(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return `${label} could not be inspected.`;
	}
	for (const [connectionId, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable) continue;
		if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return `${label}.${connectionId} must be a data property.`;
		}
		const error = validateStringArray(descriptor.value, `${label}.${connectionId}`);
		if (error) return error;
	}
	return undefined;
}

function validateFavorite(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	for (const key of ['name', 'connectionId', 'database']) {
		const error = validateRequiredField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	return undefined;
}

function validateFavorites(value: unknown, label: string): string | undefined {
	return validateDenseArray(value, label, validateFavorite);
}

function captureKnownRecord(
	input: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): SqlConnectionsProjectionParseResult<UnknownRecord> {
	if (!isRecord(input)) return failure('Captured value must be an object.');
	const captured: UnknownRecord = {};
	for (const key of requiredKeys) {
		const field = readOwnEnumerableDataProperty(input, key);
		if (!field.ok) return field;
		Object.defineProperty(captured, key, {
			value: field.value, enumerable: true, configurable: true, writable: true,
		});
	}
	for (const key of optionalKeys) {
		const field = readOptionalOwnEnumerableDataProperty(input, key);
		if (!field.ok) return field;
		if (field.value !== undefined) {
			Object.defineProperty(captured, key, {
				value: field.value, enumerable: true, configurable: true, writable: true,
			});
		}
	}
	return { ok: true, value: captured };
}

function captureDenseArray<T>(
	value: unknown,
	label: string,
	captureEntry: (entry: unknown, label: string) => SqlConnectionsProjectionParseResult<T>,
): SqlConnectionsProjectionParseResult<T[]> {
	const validationError = validateDenseArray(value, label, () => undefined);
	if (validationError) return failure(validationError);
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		if (!lengthDescriptor || typeof lengthDescriptor.value !== 'number') {
			return failure(`${label} length could not be captured.`);
		}
		const captured: T[] = [];
		for (let index = 0; index < lengthDescriptor.value; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${label}[${index}] could not be captured.`);
			}
			const entry = captureEntry(descriptor.value, `${label}[${index}]`);
			if (!entry.ok) return entry;
			captured.push(entry.value);
		}
		return { ok: true, value: captured };
	} catch {
		return failure(`${label} could not be captured.`);
	}
}

function captureStringArray(
	value: unknown,
	label: string,
): SqlConnectionsProjectionParseResult<string[]> {
	return captureDenseArray(value, label, (entry, entryLabel) =>
		typeof entry === 'string'
			? { ok: true, value: entry }
			: failure(`${entryLabel} must be a string.`));
}

function captureConnection(
	value: unknown,
	canonical: boolean,
): SqlConnectionsProjectionParseResult<UnknownRecord> {
	return captureKnownRecord(
		value,
		canonical ? ['id', 'name', 'dialect', 'serverUrl', 'authType'] : ['id', 'serverUrl'],
		canonical
			? ['port', 'database', 'username', 'credentialRevision', 'principalFingerprint', 'revocationGeneration']
			: ['name', 'dialect', 'port', 'database', 'authType', 'username', 'credentialRevision', 'principalFingerprint', 'revocationGeneration'],
	);
}

function captureStateVersions(
	value: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionStateVersions> {
	const captured = captureKnownRecord(value, ['policy', 'connections', 'principals']);
	return captured.ok
		? { ok: true, value: captured.value as SqlConnectionsProjectionStateVersions }
		: captured;
}

function captureFavorite(
	value: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionFavorite> {
	const captured = captureKnownRecord(value, ['name', 'connectionId', 'database']);
	return captured.ok
		? { ok: true, value: captured.value as SqlConnectionsProjectionFavorite }
		: captured;
}

function captureCachedDatabases(
	value: unknown,
): SqlConnectionsProjectionParseResult<Record<string, string[]>> {
	if (!isRecord(value)) return failure('cachedDatabases must be an object.');
	try {
		const captured = Object.create(null) as Record<string, string[]>;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable) continue;
			if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure('cachedDatabases entries must be enumerable string data properties.');
			}
			const databases = captureStringArray(descriptor.value, `cachedDatabases.${key}`);
			if (!databases.ok) return databases;
			Object.defineProperty(captured, key, {
				value: databases.value, enumerable: true, configurable: true, writable: true,
			});
		}
		return { ok: true, value: captured };
	} catch {
		return failure('cachedDatabases could not be captured.');
	}
}

function parseWebviewMessage(
	input: unknown,
	type: FieldParseResult<string>,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionWebviewMessage> {
	if (!type.ok) return type;
	if (!isRecord(input)) return failure('SQL connections projection request must be an object.');
	return { ok: true, value: input as unknown as SqlConnectionsProjectionRequest };
}

function parseHostMessage(
	input: unknown,
	type: FieldParseResult<string>,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionHostMessage> {
	if (!type.ok) return type;
	if (!isRecord(input)) return failure('SQL connections projection delivery must be an object.');
	const revision = readOptionalOwnEnumerableDataProperty(input, 'revision');
	if (!revision.ok) return revision;
	const canonical = revision.value !== undefined;
	if (canonical) {
		const revisionError = validateNonnegativeSafeInteger(revision.value, 'revision');
		if (revisionError) return failure(revisionError);
	}

	const connections = readOwnEnumerableDataProperty(input, 'connections');
	if (!connections.ok) return connections;
	const connectionsError = validateConnections(connections.value, 'connections', canonical);
	if (connectionsError) return failure(connectionsError);

	const fields = [
		['sqlStateVersions', validateStateVersions],
		['lastConnectionId', validateString],
		['lastDatabase', validateString],
		['cachedDatabases', validateCachedDatabases],
		['sqlFavorites', validateFavorites],
		['sqlLeaveNoTrace', validateStringArray],
	] as const;
	for (const [key, validate] of fields) {
		const error = canonical
			? validateRequiredField(input, key, validate)
			: validateOptionalField(input, key, validate);
		if (error) return failure(error);
	}
	return { ok: true, value: input as unknown as SqlConnectionsProjectionHostMessage };
}

export function isSqlConnectionsProjectionWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isSqlConnectionsProjectionHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitSqlConnectionsProjectionWebviewMessage(
	input: unknown,
): SqlConnectionsProjectionAdmissionResult<SqlConnectionsProjectionWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseWebviewMessage(input, inspection.type) };
}

export function admitSqlConnectionsProjectionHostMessage(
	input: unknown,
): SqlConnectionsProjectionAdmissionResult<SqlConnectionsProjectionHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseHostMessage(input, inspection.type) };
}

export function parseSqlConnectionsProjectionWebviewMessage(
	input: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionWebviewMessage> {
	const admission = admitSqlConnectionsProjectionWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown SQL connections projection request type.');
}

export function parseSqlConnectionsProjectionHostMessage(
	input: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionHostMessage> {
	const admission = admitSqlConnectionsProjectionHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown SQL connections projection delivery type.');
}

export function captureSqlConnectionsProjectionWebviewMessage(
	input: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionWebviewMessage> {
	const parsed = parseSqlConnectionsProjectionWebviewMessage(input);
	return parsed.ok
		? { ok: true, value: { type: 'getSqlConnections' } }
		: parsed;
}

export function captureSqlConnectionsProjectionHostMessage(
	input: unknown,
): SqlConnectionsProjectionParseResult<SqlConnectionsProjectionHostMessage> {
	const parsed = parseSqlConnectionsProjectionHostMessage(input);
	if (!parsed.ok) return parsed;
	const source = parsed.value as unknown as UnknownRecord;
	const revision = readOptionalOwnEnumerableDataProperty(source, 'revision');
	if (!revision.ok) return revision;
	const canonical = revision.value !== undefined;
	const connectionsField = readOwnEnumerableDataProperty(source, 'connections');
	if (!connectionsField.ok) return connectionsField;
	const connections = captureDenseArray(connectionsField.value, 'connections', entry =>
		captureConnection(entry, canonical));
	if (!connections.ok) return connections;

	const captured: UnknownRecord = {
		type: 'sqlConnectionsData',
		connections: connections.value,
	};
	if (canonical) captured.revision = revision.value;

	for (const key of ['sqlStateVersions', 'lastConnectionId', 'lastDatabase', 'cachedDatabases', 'sqlFavorites', 'sqlLeaveNoTrace'] as const) {
		const field = readOptionalOwnEnumerableDataProperty(source, key);
		if (!field.ok) return field;
		if (field.value === undefined) continue;
		let value: SqlConnectionsProjectionParseResult<unknown>;
		switch (key) {
			case 'sqlStateVersions': value = captureStateVersions(field.value); break;
			case 'cachedDatabases': value = captureCachedDatabases(field.value); break;
			case 'sqlFavorites': value = captureDenseArray(field.value, key, captureFavorite); break;
			case 'sqlLeaveNoTrace': value = captureStringArray(field.value, key); break;
			default:
				value = typeof field.value === 'string'
					? { ok: true, value: field.value }
					: failure(`${key} must be a string.`);
		}
		if (!value.ok) return value;
		captured[key] = value.value;
	}

	const capturedParsed = parseSqlConnectionsProjectionHostMessage(captured);
	return capturedParsed.ok
		? { ok: true, value: capturedParsed.value }
		: capturedParsed;
}