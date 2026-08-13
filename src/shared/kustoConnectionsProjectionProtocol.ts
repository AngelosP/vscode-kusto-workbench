type UnknownRecord = Record<string, unknown>;

export type KustoConnectionsProjectionParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoConnectionsProjectionAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: KustoConnectionsProjectionParseResult<T> }>;

type FieldParseResult<T> = KustoConnectionsProjectionParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type KustoConnectionsProjectionRequest = Readonly<{
	type: 'getConnections';
	policyRequestId?: string;
}>;

export type KustoConnectionsProjectionWebviewMessage = KustoConnectionsProjectionRequest;

export type KustoConnectionProjection = Readonly<{
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
	authorityId?: string;
	accountPartition?: string;
	connectionRevision: number;
	connectionIdentityKey?: string;
}>;

export type LegacyKustoConnectionProjection = Readonly<{
	id: string;
	clusterUrl: string;
	name?: string;
	database?: string;
	authorityId?: string;
	accountPartition?: string;
	connectionRevision?: number;
	connectionIdentityKey?: string;
}>;

export type KustoAccountProjection = Readonly<{
	id: string;
	label: string;
	lastUsedAt: number;
}>;

export type KustoConnectionsProjectionFavorite = Readonly<{
	name: string;
	connectionId: string;
	clusterUrl: string;
	database: string;
}>;

type KustoConnectionsProjectionFields = Readonly<{
	accounts: KustoAccountProjection[];
	lastConnectionId: string | null;
	lastDatabase: string | null;
	cachedDatabases: Record<string, string[]>;
	favorites: KustoConnectionsProjectionFavorite[];
	caretDocsEnabled: boolean;
	caretDocsEnabledUserSet: boolean;
	autoTriggerAutocompleteEnabled: boolean;
	autoTriggerAutocompleteEnabledUserSet: boolean;
	copilotInlineCompletionsEnabled: boolean;
	copilotInlineCompletionsEnabledUserSet: boolean;
	editingPreferencesRevision: number;
	copilotChatFirstTimeDismissed: boolean;
	policyRequestId?: string;
	leaveNoTraceClusters: string[];
	leaveNoTraceGloballyBlocked: boolean;
	leaveNoTraceRevisions: Record<string, number>;
	devNotesEnabled: boolean;
}>;

export type KustoConnectionsData = KustoConnectionsProjectionFields & Readonly<{
	type: 'connectionsData';
	connectionsRevision: number;
	connections: KustoConnectionProjection[];
}>;

export type LegacyKustoConnectionsData = Readonly<{
	type: 'connectionsData';
	connectionsRevision?: undefined;
	connections: LegacyKustoConnectionProjection[];
	accounts?: KustoAccountProjection[];
	lastConnectionId?: string | null;
	lastDatabase?: string | null;
	cachedDatabases?: Record<string, string[]>;
	favorites?: KustoConnectionsProjectionFavorite[];
	caretDocsEnabled?: boolean;
	caretDocsEnabledUserSet?: boolean;
	autoTriggerAutocompleteEnabled?: boolean;
	autoTriggerAutocompleteEnabledUserSet?: boolean;
	copilotInlineCompletionsEnabled?: boolean;
	copilotInlineCompletionsEnabledUserSet?: boolean;
	editingPreferencesRevision?: number;
	copilotChatFirstTimeDismissed?: boolean;
	policyRequestId?: string;
	leaveNoTraceClusters?: string[];
	leaveNoTraceGloballyBlocked?: boolean;
	leaveNoTraceRevisions?: Record<string, number>;
	devNotesEnabled?: boolean;
}>;

export type KustoConnectionsProjectionHostMessage = KustoConnectionsData | LegacyKustoConnectionsData;

const webviewMessageTypes = new Set(['getConnections']);
const hostMessageTypes = new Set(['connectionsData']);

function failure<T>(error: string): KustoConnectionsProjectionParseResult<T> {
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

function validateNullableString(value: unknown, label: string): string | undefined {
	return value === null || typeof value === 'string'
		? undefined
		: `${label} must be a string or null.`;
}

function validateBoolean(value: unknown, label: string): string | undefined {
	return typeof value === 'boolean' ? undefined : `${label} must be a boolean.`;
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
		for (let index = 0; index < lengthDescriptor.value; index++) {
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
	for (const key of ['id', 'clusterUrl']) {
		const error = validateRequiredField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	const nameError = canonical
		? validateRequiredField(value, 'name', validateString, `${label}.name`)
		: validateOptionalField(value, 'name', validateString, `${label}.name`);
	if (nameError) return nameError;
	for (const key of ['database', 'authorityId', 'accountPartition', 'connectionIdentityKey']) {
		const error = validateOptionalField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	return canonical
		? validateRequiredField(value, 'connectionRevision', validateNonnegativeSafeInteger, `${label}.connectionRevision`)
		: validateOptionalField(value, 'connectionRevision', validateNonnegativeSafeInteger, `${label}.connectionRevision`);
}

function validateConnections(value: unknown, label: string, canonical: boolean): string | undefined {
	return validateDenseArray(value, label, (entry, entryLabel) =>
		validateConnection(entry, entryLabel, canonical));
}

function validateAccount(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	for (const key of ['id', 'label']) {
		const error = validateRequiredField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	return validateRequiredField(value, 'lastUsedAt', validateFiniteNumber, `${label}.lastUsedAt`);
}

function validateAccounts(value: unknown, label: string): string | undefined {
	return validateDenseArray(value, label, validateAccount);
}

function validateFavorite(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	for (const key of ['name', 'connectionId', 'clusterUrl', 'database']) {
		const error = validateRequiredField(value, key, validateString, `${label}.${key}`);
		if (error) return error;
	}
	return undefined;
}

function validateFavorites(value: unknown, label: string): string | undefined {
	return validateDenseArray(value, label, validateFavorite);
}

function validateStringArrayRecord(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable) continue;
			if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return `${label} entries must be enumerable string data properties.`;
			}
			const error = validateStringArray(descriptor.value, `${label}.${key}`);
			if (error) return error;
		}
	} catch {
		return `${label} could not be inspected.`;
	}
	return undefined;
}

function validateRevisionRecord(value: unknown, label: string): string | undefined {
	if (!isRecord(value)) return `${label} must be an object.`;
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable) continue;
			if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return `${label} entries must be enumerable string data properties.`;
			}
			const error = validateNonnegativeSafeInteger(descriptor.value, `${label}.${key}`);
			if (error) return error;
		}
	} catch {
		return `${label} could not be inspected.`;
	}
	return undefined;
}

function captureKnownRecord(
	input: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): KustoConnectionsProjectionParseResult<UnknownRecord> {
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
	captureEntry: (entry: unknown, label: string) => KustoConnectionsProjectionParseResult<T>,
): KustoConnectionsProjectionParseResult<T[]> {
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

function captureStringArray(value: unknown, label: string): KustoConnectionsProjectionParseResult<string[]> {
	return captureDenseArray(value, label, (entry, entryLabel) =>
		typeof entry === 'string'
			? { ok: true, value: entry }
			: failure(`${entryLabel} must be a string.`));
}

function captureConnection(
	value: unknown,
	canonical: boolean,
): KustoConnectionsProjectionParseResult<UnknownRecord> {
	return captureKnownRecord(
		value,
		canonical ? ['id', 'name', 'clusterUrl', 'connectionRevision'] : ['id', 'clusterUrl'],
		canonical
			? ['database', 'authorityId', 'accountPartition', 'connectionIdentityKey']
			: ['name', 'database', 'authorityId', 'accountPartition', 'connectionRevision', 'connectionIdentityKey'],
	);
}

function captureAccount(value: unknown): KustoConnectionsProjectionParseResult<KustoAccountProjection> {
	const captured = captureKnownRecord(value, ['id', 'label', 'lastUsedAt']);
	return captured.ok
		? { ok: true, value: captured.value as KustoAccountProjection }
		: captured;
}

function captureFavorite(value: unknown): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionFavorite> {
	const captured = captureKnownRecord(value, ['name', 'connectionId', 'clusterUrl', 'database']);
	return captured.ok
		? { ok: true, value: captured.value as KustoConnectionsProjectionFavorite }
		: captured;
}

function captureRecord<T>(
	value: unknown,
	label: string,
	captureValue: (entry: unknown, label: string) => KustoConnectionsProjectionParseResult<T>,
): KustoConnectionsProjectionParseResult<Record<string, T>> {
	if (!isRecord(value)) return failure(`${label} must be an object.`);
	try {
		const captured = Object.create(null) as Record<string, T>;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable) continue;
			if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${label} entries must be enumerable string data properties.`);
			}
			const entry = captureValue(descriptor.value, `${label}.${key}`);
			if (!entry.ok) return entry;
			Object.defineProperty(captured, key, {
				value: entry.value, enumerable: true, configurable: true, writable: true,
			});
		}
		return { ok: true, value: captured };
	} catch {
		return failure(`${label} could not be captured.`);
	}
}

function captureStringArrayRecord(
	value: unknown,
	label: string,
): KustoConnectionsProjectionParseResult<Record<string, string[]>> {
	return captureRecord(value, label, captureStringArray);
}

function captureRevisionRecord(
	value: unknown,
	label: string,
): KustoConnectionsProjectionParseResult<Record<string, number>> {
	return captureRecord(value, label, (entry, entryLabel) =>
		validateNonnegativeSafeInteger(entry, entryLabel) === undefined
			? { ok: true, value: entry as number }
			: failure(`${entryLabel} must be a non-negative safe integer.`));
}

function parseWebviewMessage(
	input: unknown,
	type: FieldParseResult<string>,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionWebviewMessage> {
	if (!type.ok) return type;
	if (!isRecord(input)) return failure('Kusto connections projection request must be an object.');
	const policyRequestIdError = validateOptionalField(input, 'policyRequestId', validateString);
	return policyRequestIdError
		? failure(policyRequestIdError)
		: { ok: true, value: input as unknown as KustoConnectionsProjectionRequest };
}

function parseHostMessage(
	input: unknown,
	type: FieldParseResult<string>,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionHostMessage> {
	if (!type.ok) return type;
	if (!isRecord(input)) return failure('Kusto connections projection delivery must be an object.');
	const revision = readOptionalOwnEnumerableDataProperty(input, 'connectionsRevision');
	if (!revision.ok) return revision;
	const canonical = revision.value !== undefined;
	if (canonical) {
		const revisionError = validateNonnegativeSafeInteger(revision.value, 'connectionsRevision');
		if (revisionError) return failure(revisionError);
	}

	const connections = readOwnEnumerableDataProperty(input, 'connections');
	if (!connections.ok) return connections;
	const connectionsError = validateConnections(connections.value, 'connections', canonical);
	if (connectionsError) return failure(connectionsError);

	const fields = [
		['accounts', validateAccounts],
		['lastConnectionId', validateNullableString],
		['lastDatabase', validateNullableString],
		['cachedDatabases', validateStringArrayRecord],
		['favorites', validateFavorites],
		['caretDocsEnabled', validateBoolean],
		['caretDocsEnabledUserSet', validateBoolean],
		['autoTriggerAutocompleteEnabled', validateBoolean],
		['autoTriggerAutocompleteEnabledUserSet', validateBoolean],
		['copilotInlineCompletionsEnabled', validateBoolean],
		['copilotInlineCompletionsEnabledUserSet', validateBoolean],
		['editingPreferencesRevision', validateNonnegativeSafeInteger],
		['copilotChatFirstTimeDismissed', validateBoolean],
		['leaveNoTraceClusters', validateStringArray],
		['leaveNoTraceGloballyBlocked', validateBoolean],
		['leaveNoTraceRevisions', validateRevisionRecord],
		['devNotesEnabled', validateBoolean],
	] as const;
	for (const [key, validate] of fields) {
		const error = canonical
			? validateRequiredField(input, key, validate)
			: validateOptionalField(input, key, validate);
		if (error) return failure(error);
	}
	const policyRequestIdError = validateOptionalField(input, 'policyRequestId', validateString);
	return policyRequestIdError
		? failure(policyRequestIdError)
		: { ok: true, value: input as unknown as KustoConnectionsProjectionHostMessage };
}

export function isKustoConnectionsProjectionWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isKustoConnectionsProjectionHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitKustoConnectionsProjectionWebviewMessage(
	input: unknown,
): KustoConnectionsProjectionAdmissionResult<KustoConnectionsProjectionWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseWebviewMessage(input, inspection.type) };
}

export function admitKustoConnectionsProjectionHostMessage(
	input: unknown,
): KustoConnectionsProjectionAdmissionResult<KustoConnectionsProjectionHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseHostMessage(input, inspection.type) };
}

export function parseKustoConnectionsProjectionWebviewMessage(
	input: unknown,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionWebviewMessage> {
	const admission = admitKustoConnectionsProjectionWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Kusto connections projection request type.');
}

export function parseKustoConnectionsProjectionHostMessage(
	input: unknown,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionHostMessage> {
	const admission = admitKustoConnectionsProjectionHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Kusto connections projection delivery type.');
}

export function captureKustoConnectionsProjectionWebviewMessage(
	input: unknown,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionWebviewMessage> {
	const parsed = parseKustoConnectionsProjectionWebviewMessage(input);
	if (!parsed.ok) return parsed;
	const source = parsed.value as unknown as UnknownRecord;
	const policyRequestId = readOptionalOwnEnumerableDataProperty(source, 'policyRequestId');
	if (!policyRequestId.ok) return policyRequestId;
	const captured = {
		type: 'getConnections' as const,
		...(policyRequestId.value !== undefined ? { policyRequestId: policyRequestId.value } : {}),
	};
	const capturedParsed = parseKustoConnectionsProjectionWebviewMessage(captured);
	return capturedParsed.ok
		? { ok: true, value: capturedParsed.value }
		: capturedParsed;
}

export function captureKustoConnectionsProjectionHostMessage(
	input: unknown,
): KustoConnectionsProjectionParseResult<KustoConnectionsProjectionHostMessage> {
	const parsed = parseKustoConnectionsProjectionHostMessage(input);
	if (!parsed.ok) return parsed;
	const source = parsed.value as unknown as UnknownRecord;
	const revision = readOptionalOwnEnumerableDataProperty(source, 'connectionsRevision');
	if (!revision.ok) return revision;
	const canonical = revision.value !== undefined;
	const connectionsField = readOwnEnumerableDataProperty(source, 'connections');
	if (!connectionsField.ok) return connectionsField;
	const connections = captureDenseArray(connectionsField.value, 'connections', entry =>
		captureConnection(entry, canonical));
	if (!connections.ok) return connections;

	const captured: UnknownRecord = {
		type: 'connectionsData',
		connections: connections.value,
	};
	if (canonical) captured.connectionsRevision = revision.value;

	const fields = [
		'accounts',
		'lastConnectionId',
		'lastDatabase',
		'cachedDatabases',
		'favorites',
		'caretDocsEnabled',
		'caretDocsEnabledUserSet',
		'autoTriggerAutocompleteEnabled',
		'autoTriggerAutocompleteEnabledUserSet',
		'copilotInlineCompletionsEnabled',
		'copilotInlineCompletionsEnabledUserSet',
		'editingPreferencesRevision',
		'copilotChatFirstTimeDismissed',
		'leaveNoTraceClusters',
		'leaveNoTraceGloballyBlocked',
		'leaveNoTraceRevisions',
		'devNotesEnabled',
	] as const;
	for (const key of fields) {
		const field = canonical
			? readOwnEnumerableDataProperty(source, key)
			: readOptionalOwnEnumerableDataProperty(source, key);
		if (!field.ok) return field;
		if (!canonical && field.value === undefined) continue;
		let value: KustoConnectionsProjectionParseResult<unknown>;
		switch (key) {
			case 'accounts': value = captureDenseArray(field.value, key, captureAccount); break;
			case 'cachedDatabases': value = captureStringArrayRecord(field.value, key); break;
			case 'favorites': value = captureDenseArray(field.value, key, captureFavorite); break;
			case 'leaveNoTraceClusters': value = captureStringArray(field.value, key); break;
			case 'leaveNoTraceRevisions': value = captureRevisionRecord(field.value, key); break;
			default: value = { ok: true, value: field.value };
		}
		if (!value.ok) return value;
		Object.defineProperty(captured, key, {
			value: value.value, enumerable: true, configurable: true, writable: true,
		});
	}
	const policyRequestId = readOptionalOwnEnumerableDataProperty(source, 'policyRequestId');
	if (!policyRequestId.ok) return policyRequestId;
	if (policyRequestId.value !== undefined) captured.policyRequestId = policyRequestId.value;

	const capturedParsed = parseKustoConnectionsProjectionHostMessage(captured);
	return capturedParsed.ok
		? { ok: true, value: capturedParsed.value }
		: capturedParsed;
}