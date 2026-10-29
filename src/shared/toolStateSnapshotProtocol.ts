import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope';
import type { KustoEditorLifecycleIdentity } from './kustoSchemaLifecycle';

type UnknownRecord = Record<string, unknown>;

export type ToolStateSnapshotParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type ToolStateSnapshotAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: ToolStateSnapshotParseResult<T> }>;

export type ToolStateSection = UnknownRecord & {
	type: string;
	sectionInstanceId?: string;
	targetGeneration?: number;
	connectionId?: string;
	clusterUrl?: string;
	database?: string;
};

export type ExpectedKustoTarget = KustoEditorLifecycleIdentity & Readonly<{
	sectionId: string;
	connectionId: string;
	clusterUrl: string;
	database: string;
}>;

export type RequestToolStateMessage = {
	type: 'requestToolState';
	requestId: string;
	purpose?: 'schema-refresh';
	targetConnectionId?: string;
};

export type ToolStateResponseMessage = {
	type: 'toolStateResponse';
	requestId: string;
	sections: ToolStateSection[];
	error?: string;
};

export type ToolStateSnapshotHostMessage = RequestToolStateMessage;
export type ToolStateSnapshotWebviewMessage = ToolStateResponseMessage;

type SnapshotValueContext = {
	readonly active: Set<object>;
	values: number;
	stringCharacters: number;
};

const hostTypes = new Set(['requestToolState']);
const webviewTypes = new Set(['toolStateResponse']);
const maximumSnapshotDepth = 64;
const maximumSnapshotValues = 250_000;
const maximumContainerEntries = 10_000;
const maximumSnapshotStringCharacters = 16 * 1024 * 1024;
const snapshotStringLimitError = 'Tool state exceeds the snapshot string limit.';
const hostAdmissionCache = new WeakMap<object, ToolStateSnapshotAdmissionResult<ToolStateSnapshotHostMessage>>();
const webviewAdmissionCache = new WeakMap<object, ToolStateSnapshotAdmissionResult<ToolStateSnapshotWebviewMessage>>();

function failure<T>(error: string): ToolStateSnapshotParseResult<T> {
	return { ok: false, error };
}

function canonicalFailure<T>(label: string): ToolStateSnapshotParseResult<T> {
	return failure(`${label} must use a canonical object prototype.`);
}

function dataPropertyFailure(key: string): ToolStateSnapshotParseResult<never> {
	return failure(`${key} must be an own enumerable data property.`);
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function isEnumerableDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
	return !!descriptor && !!descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function isCanonicalRecordPrototype(prototype: object | null): boolean {
	return prototype === Object.prototype || prototype === null;
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): boolean {
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) return false;
	try {
		let owner: object | null = input as object;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) return true;
			seen.add(owner);
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'type');
			if (descriptor) {
				const value = descriptorValue(descriptor);
				return typeof value !== 'string' || types.has(value);
			}
			owner = Object.getPrototypeOf(owner);
		}
		return depth > 16;
	} catch {
		return true;
	}
}

function getSnapshot(
	input: unknown,
): ToolStateSnapshotParseResult<RuntimeMessageEnvelopeDescriptorSnapshot> {
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (existing) return { ok: true, value: existing };
	const captured = captureRuntimeMessageEnvelope(input);
	return captured.ok ? { ok: true, value: captured.descriptorSnapshot } : captured;
}

function readString(
	descriptors: PropertyDescriptorMap,
	key: string,
	required: true,
): ToolStateSnapshotParseResult<string>;
function readString(
	descriptors: PropertyDescriptorMap,
	key: string,
	required?: false,
): ToolStateSnapshotParseResult<string | undefined>;
function readString(
	descriptors: PropertyDescriptorMap,
	key: string,
	required = false,
): ToolStateSnapshotParseResult<string | undefined> {
	const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
	if (!descriptor && !required) return { ok: true, value: undefined };
	if (!isEnumerableDataDescriptor(descriptor)) {
		return dataPropertyFailure(key);
	}
	const value = descriptor.value;
	return (value === undefined && !required) || (typeof value === 'string' && (!required || value.trim()))
		? { ok: true, value }
		: failure(`${key} must be ${required ? 'a nonblank string' : 'a string when provided'}.`);
}

function validateExactFields(
	descriptors: PropertyDescriptorMap,
	allowed: ReadonlySet<string>,
	label: string,
): string | undefined {
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) return `${label} contains an unsupported field.`;
		const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
		if (!isEnumerableDataDescriptor(descriptor)) {
			return `${label} fields must be own enumerable data properties.`;
		}
	}
	return undefined;
}

function captureSnapshotValue(
	input: unknown,
	path: string,
	context: SnapshotValueContext,
	depth: number,
): ToolStateSnapshotParseResult<unknown> {
	if (++context.values > maximumSnapshotValues) {
		return failure('Tool state exceeds the snapshot value limit.');
	}
	if (typeof input === 'string') {
		context.stringCharacters += input.length;
		return context.stringCharacters <= maximumSnapshotStringCharacters
			? { ok: true, value: input }
			: failure(snapshotStringLimitError);
	}
	if (input === null || input === undefined || typeof input === 'boolean') {
		return { ok: true, value: input };
	}
	if (typeof input === 'number') {
		return Number.isFinite(input)
			? { ok: true, value: input }
			: failure(`${path} must contain only finite numbers.`);
	}
	if (typeof input !== 'object') return failure(`${path} contains an unsupported value.`);
	if (depth > maximumSnapshotDepth) return failure(`${path} exceeds the snapshot depth limit.`);
	if (context.active.has(input)) return failure(`${path} must not be cyclic.`);
	if (isRuntimeProxy(input)) return failure(`${path} must not be a proxy.`);

	context.active.add(input);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const prototype = Object.getPrototypeOf(input);
		if (Array.isArray(input)) {
			if (prototype !== Array.prototype
				|| Reflect.get(descriptors, Symbol.iterator) !== undefined) {
				return failure(`${path} must use the canonical array prototype and iterator.`);
			}
			const lengthDescriptor = Reflect.get(descriptors, 'length') as PropertyDescriptor | undefined;
			const length = descriptorValue(lengthDescriptor);
			if (!Number.isSafeInteger(length) || (length as number) < 0) {
				return failure(`${path} must have a valid array length.`);
			}
			if ((length as number) > maximumContainerEntries) {
				return failure(`${path} exceeds the array entry limit.`);
			}
			const allowedKeys = new Set<PropertyKey>(['length']);
			const captured: unknown[] = [];
			for (let index = 0; index < (length as number); index++) {
				const key = String(index);
				allowedKeys.add(key);
				const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
				if (!isEnumerableDataDescriptor(descriptor)) {
					return failure(`${path} must be dense and contain only data entries.`);
				}
				const item = captureSnapshotValue(descriptor.value, `${path}[${index}]`, context, depth + 1);
				if (!item.ok) return item;
				captured.push(item.value);
			}
			for (const key of Reflect.ownKeys(descriptors)) {
				if (!allowedKeys.has(key)) return failure(`${path} contains an unsupported array field.`);
			}
			return { ok: true, value: Object.freeze(captured) };
		}

		if (!isCanonicalRecordPrototype(prototype)) {
			return canonicalFailure(path);
		}
		const keys = Reflect.ownKeys(descriptors);
		if (keys.length > maximumContainerEntries) {
			return failure(`${path} exceeds the object field limit.`);
		}
		const captured = Object.create(null) as UnknownRecord;
		for (const key of keys) {
			if (typeof key !== 'string') return failure(`${path} contains a symbol field.`);
			context.stringCharacters += key.length;
			if (context.stringCharacters > maximumSnapshotStringCharacters) {
				return failure(snapshotStringLimitError);
			}
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!isEnumerableDataDescriptor(descriptor)) {
				return dataPropertyFailure(`${path}.${key}`);
			}
			const value = captureSnapshotValue(descriptor.value, `${path}.${key}`, context, depth + 1);
			if (!value.ok) return value;
			captured[key] = value.value;
		}
		return { ok: true, value: Object.freeze(captured) };
	} catch {
		return failure(`${path} could not be inspected.`);
	} finally {
		context.active.delete(input);
	}
}

export function captureToolStateSections(input: unknown): ToolStateSnapshotParseResult<ToolStateSection[]> {
	const captured = captureSnapshotValue(
		input,
		'sections',
		{ active: new Set(), values: 0, stringCharacters: 0 },
		0,
	);
	if (!captured.ok) return captured;
	if (!Array.isArray(captured.value)) return failure('sections must be an array.');
	for (let index = 0; index < captured.value.length; index++) {
		const section = captured.value[index];
		if (!section || typeof section !== 'object' || Array.isArray(section)) {
			return failure(`sections[${index}] must be an object.`);
		}
		const type = Reflect.get(section, 'type');
		if (typeof type !== 'string') return failure(`sections[${index}].type must be a string.`);
		const id = Reflect.get(section, 'id');
		if (id !== undefined && typeof id !== 'string') {
			return failure(`sections[${index}].id must be a string when provided.`);
		}
		for (const key of ['sectionInstanceId', 'connectionId', 'clusterUrl', 'database']) {
			const value = Reflect.get(section, key);
			if (value !== undefined && typeof value !== 'string') {
				return failure(`sections[${index}].${key} must be a string when provided.`);
			}
		}
		const generation = Reflect.get(section, 'targetGeneration');
		if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
			return failure(`sections[${index}].targetGeneration must be a non-negative safe integer when provided.`);
		}
	}
	return { ok: true, value: captured.value as ToolStateSection[] };
}

export function captureExpectedKustoTarget(input: unknown): ToolStateSnapshotParseResult<ExpectedKustoTarget> {
	const captured = captureSnapshotValue(
		input, 'Expected Kusto target', { active: new Set(), values: 0, stringCharacters: 0 }, 0,
	);
	if (!captured.ok) return captured;
	if (!captured.value || typeof captured.value !== 'object' || Array.isArray(captured.value)) {
		return canonicalFailure('Expected Kusto target');
	}
	const snapshot = { descriptors: Object.getOwnPropertyDescriptors(captured.value) };
	const error = validateExactFields(snapshot.descriptors, new Set([
		'sectionId', 'sectionInstanceId', 'targetGeneration', 'connectionId', 'clusterUrl', 'database',
	]), 'Expected Kusto target');
	if (error) return failure(error);
	const sectionId = readString(snapshot.descriptors, 'sectionId', true);
	if (!sectionId.ok) return sectionId;
	const sectionInstanceId = readString(snapshot.descriptors, 'sectionInstanceId', true);
	if (!sectionInstanceId.ok) return sectionInstanceId;
	const connectionId = readString(snapshot.descriptors, 'connectionId', true);
	if (!connectionId.ok) return connectionId;
	const clusterUrl = readString(snapshot.descriptors, 'clusterUrl', true);
	if (!clusterUrl.ok) return clusterUrl;
	const database = readString(snapshot.descriptors, 'database', true);
	if (!database.ok) return database;
	const generation = Reflect.get(snapshot.descriptors, 'targetGeneration') as PropertyDescriptor | undefined;
	if (!isEnumerableDataDescriptor(generation)) return dataPropertyFailure('targetGeneration');
	const targetGeneration: unknown = generation.value;
	if (typeof targetGeneration !== 'number' || !Number.isSafeInteger(targetGeneration) || targetGeneration < 0) {
		return failure('targetGeneration must be a non-negative safe integer.');
	}
	return { ok: true, value: Object.freeze({
		sectionId: sectionId.value, sectionInstanceId: sectionInstanceId.value, targetGeneration,
		connectionId: connectionId.value, clusterUrl: clusterUrl.value, database: database.value,
	}) };
}

function parseSnapshotRequestId(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
	expectedType: string,
	allowed: ReadonlySet<string>,
	label: string,
): ToolStateSnapshotParseResult<string> {
	if (isRuntimeProxy(snapshot.input) || !isCanonicalRecordPrototype(snapshot.prototype)) {
		return canonicalFailure(label);
	}
	const fieldsError = validateExactFields(snapshot.descriptors, allowed, label);
	if (fieldsError) return failure(fieldsError);
	const type = readString(snapshot.descriptors, 'type', true);
	if (!type.ok || type.value !== expectedType) return failure(`Unknown ${label.toLowerCase()} type.`);
	return readString(snapshot.descriptors, 'requestId', true);
}

function parseHostSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): ToolStateSnapshotParseResult<ToolStateSnapshotHostMessage> {
	const requestId = parseSnapshotRequestId(snapshot, 'requestToolState',
		new Set(['type', 'requestId', 'purpose', 'targetConnectionId']), 'Tool-state request');
	if (!requestId.ok) return requestId;
	const purpose = readString(snapshot.descriptors, 'purpose');
	if (!purpose.ok) return purpose;
	if (purpose.value !== undefined && purpose.value !== 'schema-refresh') {
		return failure('purpose must be schema-refresh when provided.');
	}
	const targetConnectionId = readString(snapshot.descriptors, 'targetConnectionId');
	if (!targetConnectionId.ok) return targetConnectionId;
	return {
		ok: true,
		value: Object.freeze({
			type: 'requestToolState',
			requestId: requestId.value,
			...(purpose.value !== undefined ? { purpose: purpose.value } : {}),
			...(targetConnectionId.value !== undefined ? { targetConnectionId: targetConnectionId.value } : {}),
		}),
	};
}

function parseWebviewSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): ToolStateSnapshotParseResult<ToolStateSnapshotWebviewMessage> {
	const requestId = parseSnapshotRequestId(snapshot, 'toolStateResponse',
		new Set(['type', 'requestId', 'sections', 'error']), 'Tool-state response');
	if (!requestId.ok) return requestId;
	const sectionsDescriptor = Reflect.get(snapshot.descriptors, 'sections') as PropertyDescriptor | undefined;
	if (!isEnumerableDataDescriptor(sectionsDescriptor)) {
		return dataPropertyFailure('sections');
	}
	const sections = captureToolStateSections(sectionsDescriptor.value);
	if (!sections.ok) return sections;
	const error = readString(snapshot.descriptors, 'error');
	if (!error.ok) return error;
	return {
		ok: true,
		value: Object.freeze({
			type: 'toolStateResponse',
			requestId: requestId.value,
			sections: sections.value,
			...(error.value !== undefined ? { error: error.value } : {}),
		}),
	};
}

function getCachedAdmission<T>(
	cache: WeakMap<object, ToolStateSnapshotAdmissionResult<T>>,
	input: unknown,
): ToolStateSnapshotAdmissionResult<T> | undefined {
	return input && (typeof input === 'object' || typeof input === 'function')
		? cache.get(input as object)
		: undefined;
}

function cacheAdmission<T>(
	cache: WeakMap<object, ToolStateSnapshotAdmissionResult<T>>,
	input: unknown,
	admission: ToolStateSnapshotAdmissionResult<T>,
): ToolStateSnapshotAdmissionResult<T> {
	const immutable = Object.freeze(admission);
	if (input && (typeof input === 'object' || typeof input === 'function')) {
		cache.set(input as object, immutable);
	}
	if (immutable.recognized && immutable.parsed.ok
		&& immutable.parsed.value && typeof immutable.parsed.value === 'object') {
		cache.set(immutable.parsed.value as object, immutable);
	}
	return immutable;
}

function admitFromEnvelope<T>(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
	types: ReadonlySet<string>,
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => ToolStateSnapshotParseResult<T>,
	cache: WeakMap<object, ToolStateSnapshotAdmissionResult<T>>,
): ToolStateSnapshotAdmissionResult<T> {
	const cached = getCachedAdmission(cache, snapshot.input);
	if (cached) return cached;
	const type = descriptorValue(Reflect.get(snapshot.descriptors, 'type') as PropertyDescriptor | undefined);
	if (typeof type === 'string' && !types.has(type)) return { recognized: false };
	return cacheAdmission(
		cache,
		snapshot.input,
		{ recognized: true, parsed: typeof type === 'string' ? parser(snapshot) : failure('type must be a string.') },
	);
}

function admitInput<T>(
	input: unknown,
	types: ReadonlySet<string>,
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => ToolStateSnapshotParseResult<T>,
	cache: WeakMap<object, ToolStateSnapshotAdmissionResult<T>>,
): ToolStateSnapshotAdmissionResult<T> {
	const cached = getCachedAdmission(cache, input);
	if (cached) return cached;
	const snapshot = getSnapshot(input);
	if (!snapshot.ok) {
		return inspectKnownType(input, types)
			? { recognized: true, parsed: snapshot }
			: { recognized: false };
	}
	return admitFromEnvelope(snapshot.value, types, parser, cache);
}

export function createRequestToolStateMessage(
	requestId: string,
	purpose?: 'schema-refresh',
	targetConnectionId?: string,
): ToolStateSnapshotParseResult<RequestToolStateMessage> {
	return parseToolStateSnapshotHostMessage({
		type: 'requestToolState',
		requestId,
		...(purpose ? { purpose } : {}),
		...(targetConnectionId ? { targetConnectionId } : {}),
	});
}

export function createToolStateResponseMessage(
	requestId: string,
	sections: unknown,
	error?: string,
): ToolStateSnapshotParseResult<ToolStateResponseMessage> {
	return parseToolStateSnapshotWebviewMessage({
		type: 'toolStateResponse',
		requestId,
		sections,
		...(error !== undefined ? { error } : {}),
	});
}

export function admitToolStateSnapshotHostMessage(
	input: unknown,
): ToolStateSnapshotAdmissionResult<ToolStateSnapshotHostMessage> {
	return admitInput(input, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitToolStateSnapshotHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): ToolStateSnapshotAdmissionResult<ToolStateSnapshotHostMessage> {
	return admitFromEnvelope(snapshot, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitToolStateSnapshotWebviewMessage(
	input: unknown,
): ToolStateSnapshotAdmissionResult<ToolStateSnapshotWebviewMessage> {
	return admitInput(input, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function admitToolStateSnapshotWebviewMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): ToolStateSnapshotAdmissionResult<ToolStateSnapshotWebviewMessage> {
	return admitFromEnvelope(snapshot, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function parseToolStateSnapshotHostMessage(
	input: unknown,
): ToolStateSnapshotParseResult<ToolStateSnapshotHostMessage> {
	const admission = admitToolStateSnapshotHostMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown tool-state request type.');
}

export function parseToolStateSnapshotWebviewMessage(
	input: unknown,
): ToolStateSnapshotParseResult<ToolStateSnapshotWebviewMessage> {
	const admission = admitToolStateSnapshotWebviewMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown tool-state response type.');
}