import type {
	KustoComparisonRunIdentity,
	KustoExecutionProducer,
	KustoExecutionReservation,
} from './kustoExecution';
import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope';

export type KustoExecutionStartParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoExecutionStartAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: KustoExecutionStartParseResult<T> }>;

export type KustoExecutionStartedMessage = KustoExecutionReservation & Readonly<{
	type: 'kustoExecutionStarted';
	query: string;
	expectedPredecessorExecutionId?: string;
}>;

export type KustoExecutionStartedAckMessage = Readonly<{
	type: 'kustoExecutionStartedAck';
	boxId: string;
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	accepted: boolean;
}>;

export type KustoExecutionStartHostMessage = KustoExecutionStartedMessage;
export type KustoExecutionStartWebviewMessage = KustoExecutionStartedAckMessage;

const hostTypes = new Set(['kustoExecutionStarted']);
const webviewTypes = new Set(['kustoExecutionStartedAck']);
const hostAdmissionCache = new WeakMap<object, KustoExecutionStartAdmissionResult<KustoExecutionStartHostMessage>>();
const webviewAdmissionCache = new WeakMap<object, KustoExecutionStartAdmissionResult<KustoExecutionStartWebviewMessage>>();

function failure<T>(error: string): KustoExecutionStartParseResult<T> {
	return { ok: false, error };
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function getDescriptor(
	descriptors: PropertyDescriptorMap,
	key: string,
): PropertyDescriptor | undefined {
	return Object.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined;
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
): KustoExecutionStartParseResult<RuntimeMessageEnvelopeDescriptorSnapshot> {
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (existing) return { ok: true, value: existing };
	if (isRuntimeProxy(input)) return failure('Kusto execution-start message must not be a proxy.');
	const captured = captureRuntimeMessageEnvelope(input);
	return captured.ok ? { ok: true, value: captured.descriptorSnapshot } : captured;
}

function validateExactFields(
	descriptors: PropertyDescriptorMap,
	allowed: ReadonlySet<string>,
	label: string,
): string | undefined {
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) return `${label} contains an unsupported field.`;
		const descriptor = getDescriptor(descriptors, key);
		if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return `${label} fields must be own enumerable data properties.`;
		}
	}
	return undefined;
}

function readRequiredString(
	descriptors: PropertyDescriptorMap,
	key: string,
	nonblank = true,
): KustoExecutionStartParseResult<string> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	if (typeof descriptor.value !== 'string' || (nonblank && !descriptor.value.trim())) {
		return failure(`${key} must be ${nonblank ? 'a nonblank string' : 'a string'}.`);
	}
	return { ok: true, value: descriptor.value };
}

function readOptionalNonblankString(
	descriptors: PropertyDescriptorMap,
	key: string,
): KustoExecutionStartParseResult<string | undefined> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor) return { ok: true, value: undefined };
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return typeof descriptor.value === 'string' && descriptor.value.trim().length > 0
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a nonblank string when provided.`);
}

function readNonnegativeSafeInteger(
	descriptors: PropertyDescriptorMap,
	key: string,
	positive = false,
): KustoExecutionStartParseResult<number> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	if (!Number.isSafeInteger(descriptor.value)
		|| (positive ? Number(descriptor.value) <= 0 : Number(descriptor.value) < 0)) {
		return failure(`${key} must be ${positive ? 'a positive' : 'a nonnegative'} safe integer.`);
	}
	return { ok: true, value: descriptor.value as number };
}

function captureComparisonRun(
	input: unknown,
	envelope: object,
): KustoExecutionStartParseResult<KustoComparisonRunIdentity> {
	if (!input || typeof input !== 'object' || input === envelope || isRuntimeProxy(input)) {
		return failure('comparisonRun must be a distinct canonical object record.');
	}
	try {
		if (Array.isArray(input) || !isCanonicalRecordPrototype(Object.getPrototypeOf(input))) {
			return failure('comparisonRun must use a canonical object prototype.');
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const fieldsError = validateExactFields(
			descriptors,
			new Set(['sourceBoxId', 'sourceExecutionId', 'comparisonBoxId']),
			'comparisonRun',
		);
		if (fieldsError || Reflect.ownKeys(descriptors).length !== 3) {
			return failure(fieldsError ?? 'comparisonRun must contain all canonical fields.');
		}
		const sourceBoxId = readRequiredString(descriptors, 'sourceBoxId');
		if (!sourceBoxId.ok) return sourceBoxId;
		const sourceExecutionId = readRequiredString(descriptors, 'sourceExecutionId');
		if (!sourceExecutionId.ok) return sourceExecutionId;
		const comparisonBoxId = readRequiredString(descriptors, 'comparisonBoxId');
		if (!comparisonBoxId.ok) return comparisonBoxId;
		return {
			ok: true,
			value: Object.freeze({
				sourceBoxId: sourceBoxId.value,
				sourceExecutionId: sourceExecutionId.value,
				comparisonBoxId: comparisonBoxId.value,
			}),
		};
	} catch {
		return failure('comparisonRun could not be inspected.');
	}
}

function captureReservationForConstruction(
	input: unknown,
): KustoExecutionStartParseResult<KustoExecutionReservation> {
	if (!input || typeof input !== 'object' || isRuntimeProxy(input)) {
		return failure('Kusto execution reservation must be a canonical object record.');
	}
	try {
		if (Array.isArray(input) || !isCanonicalRecordPrototype(Object.getPrototypeOf(input))) {
			return failure('Kusto execution reservation must use a canonical object prototype.');
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const fieldsError = validateExactFields(
			descriptors,
			new Set([
				'engine', 'boxId', 'sectionInstanceId', 'targetGeneration', 'connectionId',
				'database', 'executionId', 'producer', 'query', 'copilotRequestId',
				'comparisonRun', 'reservationSequence',
			]),
			'Kusto execution reservation',
		);
		if (fieldsError) return failure(fieldsError);
		const engine = readRequiredString(descriptors, 'engine');
		if (!engine.ok || engine.value !== 'kusto') return failure('engine must be kusto.');
		const boxId = readRequiredString(descriptors, 'boxId');
		if (!boxId.ok) return boxId;
		const sectionInstanceId = readRequiredString(descriptors, 'sectionInstanceId');
		if (!sectionInstanceId.ok) return sectionInstanceId;
		const targetGeneration = readNonnegativeSafeInteger(descriptors, 'targetGeneration');
		if (!targetGeneration.ok) return targetGeneration;
		const connectionId = readRequiredString(descriptors, 'connectionId');
		if (!connectionId.ok) return connectionId;
		const database = readRequiredString(descriptors, 'database');
		if (!database.ok) return database;
		const executionId = readRequiredString(descriptors, 'executionId');
		if (!executionId.ok) return executionId;
		const producer = readRequiredString(descriptors, 'producer');
		if (!producer.ok || (producer.value !== 'copilot' && producer.value !== 'comparison')) {
			return failure('Execution-start producer must be copilot or comparison.');
		}
		const reservationSequence = readNonnegativeSafeInteger(descriptors, 'reservationSequence', true);
		if (!reservationSequence.ok) return reservationSequence;
		const copilotRequestId = readOptionalNonblankString(descriptors, 'copilotRequestId');
		if (!copilotRequestId.ok) return copilotRequestId;
		const queryDescriptor = getDescriptor(descriptors, 'query');
		if (queryDescriptor && typeof queryDescriptor.value !== 'string') {
			return failure('query must be a string when provided.');
		}

		const comparisonDescriptor = getDescriptor(descriptors, 'comparisonRun');
		let comparisonRun: KustoComparisonRunIdentity | undefined;
		if (producer.value === 'comparison') {
			if (!comparisonDescriptor) return failure('Comparison starts require comparisonRun.');
			const captured = captureComparisonRun(comparisonDescriptor.value, input);
			if (!captured.ok) return captured;
			comparisonRun = captured.value;
			if (!((boxId.value === comparisonRun.sourceBoxId
				&& executionId.value === comparisonRun.sourceExecutionId)
				|| boxId.value === comparisonRun.comparisonBoxId)) {
				return failure('comparisonRun must identify the started source or comparison execution.');
			}
		} else if (comparisonDescriptor) {
			return failure('Copilot starts must not include comparisonRun.');
		}

		return {
			ok: true,
			value: Object.freeze({
				engine: 'kusto',
				boxId: boxId.value,
				sectionInstanceId: sectionInstanceId.value,
				targetGeneration: targetGeneration.value,
				connectionId: connectionId.value,
				database: database.value,
				executionId: executionId.value,
				producer: producer.value,
				reservationSequence: reservationSequence.value,
				...(queryDescriptor ? { query: queryDescriptor.value as string } : {}),
				...(copilotRequestId.value ? { copilotRequestId: copilotRequestId.value } : {}),
				...(comparisonRun ? { comparisonRun } : {}),
			}),
		};
	} catch {
		return failure('Kusto execution reservation could not be inspected.');
	}
}

function parseHostSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoExecutionStartParseResult<KustoExecutionStartHostMessage> {
	if (!isCanonicalRecordPrototype(snapshot.prototype)) {
		return failure('Kusto execution-start message must use a canonical object prototype.');
	}
	const fieldsError = validateExactFields(
		snapshot.descriptors,
		new Set([
			'type', 'engine', 'boxId', 'sectionInstanceId', 'targetGeneration', 'connectionId',
			'database', 'executionId', 'producer', 'query', 'copilotRequestId', 'comparisonRun',
			'reservationSequence', 'expectedPredecessorExecutionId',
		]),
		'Kusto execution-start message',
	);
	if (fieldsError) return failure(fieldsError);
	const type = readRequiredString(snapshot.descriptors, 'type');
	if (!type.ok || type.value !== 'kustoExecutionStarted') {
		return failure('Unknown Kusto execution-start host message type.');
	}
	const engine = readRequiredString(snapshot.descriptors, 'engine');
	if (!engine.ok || engine.value !== 'kusto') return failure('engine must be kusto.');
	const boxId = readRequiredString(snapshot.descriptors, 'boxId');
	if (!boxId.ok) return boxId;
	const sectionInstanceId = readRequiredString(snapshot.descriptors, 'sectionInstanceId');
	if (!sectionInstanceId.ok) return sectionInstanceId;
	const targetGeneration = readNonnegativeSafeInteger(snapshot.descriptors, 'targetGeneration');
	if (!targetGeneration.ok) return targetGeneration;
	const connectionId = readRequiredString(snapshot.descriptors, 'connectionId');
	if (!connectionId.ok) return connectionId;
	const database = readRequiredString(snapshot.descriptors, 'database');
	if (!database.ok) return database;
	const executionId = readRequiredString(snapshot.descriptors, 'executionId');
	if (!executionId.ok) return executionId;
	const producer = readRequiredString(snapshot.descriptors, 'producer');
	if (!producer.ok || (producer.value !== 'copilot' && producer.value !== 'comparison')) {
		return failure('Execution-start producer must be copilot or comparison.');
	}
	const query = readRequiredString(snapshot.descriptors, 'query', false);
	if (!query.ok) return query;
	const reservationSequence = readNonnegativeSafeInteger(
		snapshot.descriptors,
		'reservationSequence',
		true,
	);
	if (!reservationSequence.ok) return reservationSequence;
	const copilotRequestId = readOptionalNonblankString(snapshot.descriptors, 'copilotRequestId');
	if (!copilotRequestId.ok) return copilotRequestId;
	const expectedPredecessorExecutionId = readOptionalNonblankString(
		snapshot.descriptors,
		'expectedPredecessorExecutionId',
	);
	if (!expectedPredecessorExecutionId.ok) return expectedPredecessorExecutionId;

	const comparisonDescriptor = getDescriptor(snapshot.descriptors, 'comparisonRun');
	let comparisonRun: KustoComparisonRunIdentity | undefined;
	if (producer.value === 'comparison') {
		if (!comparisonDescriptor) return failure('Comparison starts require comparisonRun.');
		const captured = captureComparisonRun(comparisonDescriptor.value, snapshot.input);
		if (!captured.ok) return captured;
		comparisonRun = captured.value;
		if (!((boxId.value === comparisonRun.sourceBoxId
			&& executionId.value === comparisonRun.sourceExecutionId)
			|| boxId.value === comparisonRun.comparisonBoxId)) {
			return failure('comparisonRun must identify the started source or comparison execution.');
		}
	} else if (comparisonDescriptor) {
		return failure('Copilot starts must not include comparisonRun.');
	}

	return {
		ok: true,
		value: Object.freeze({
			type: 'kustoExecutionStarted',
			engine: 'kusto',
			boxId: boxId.value,
			sectionInstanceId: sectionInstanceId.value,
			targetGeneration: targetGeneration.value,
			connectionId: connectionId.value,
			database: database.value,
			executionId: executionId.value,
			producer: producer.value,
			query: query.value,
			reservationSequence: reservationSequence.value,
			...(copilotRequestId.value ? { copilotRequestId: copilotRequestId.value } : {}),
			...(comparisonRun ? { comparisonRun } : {}),
			...(expectedPredecessorExecutionId.value
				? { expectedPredecessorExecutionId: expectedPredecessorExecutionId.value }
				: {}),
		}),
	};
}

function parseWebviewSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoExecutionStartParseResult<KustoExecutionStartWebviewMessage> {
	if (!isCanonicalRecordPrototype(snapshot.prototype)) {
		return failure('Kusto execution-start acknowledgement must use a canonical object prototype.');
	}
	const fieldsError = validateExactFields(
		snapshot.descriptors,
		new Set(['type', 'boxId', 'executionId', 'sectionInstanceId', 'targetGeneration', 'accepted']),
		'Kusto execution-start acknowledgement',
	);
	if (fieldsError || Reflect.ownKeys(snapshot.descriptors).length !== 6) {
		return failure(fieldsError ?? 'Kusto execution-start acknowledgement must contain all canonical fields.');
	}
	const type = readRequiredString(snapshot.descriptors, 'type');
	if (!type.ok || type.value !== 'kustoExecutionStartedAck') {
		return failure('Unknown Kusto execution-start acknowledgement type.');
	}
	const boxId = readRequiredString(snapshot.descriptors, 'boxId');
	if (!boxId.ok) return boxId;
	const executionId = readRequiredString(snapshot.descriptors, 'executionId');
	if (!executionId.ok) return executionId;
	const sectionInstanceId = readRequiredString(snapshot.descriptors, 'sectionInstanceId');
	if (!sectionInstanceId.ok) return sectionInstanceId;
	const targetGeneration = readNonnegativeSafeInteger(snapshot.descriptors, 'targetGeneration');
	if (!targetGeneration.ok) return targetGeneration;
	const acceptedDescriptor = getDescriptor(snapshot.descriptors, 'accepted');
	if (!acceptedDescriptor || typeof acceptedDescriptor.value !== 'boolean') {
		return failure('accepted must be a boolean.');
	}
	return {
		ok: true,
		value: Object.freeze({
			type: 'kustoExecutionStartedAck',
			boxId: boxId.value,
			executionId: executionId.value,
			sectionInstanceId: sectionInstanceId.value,
			targetGeneration: targetGeneration.value,
			accepted: acceptedDescriptor.value,
		}),
	};
}

function getCachedAdmission<T>(
	cache: WeakMap<object, KustoExecutionStartAdmissionResult<T>>,
	input: unknown,
): KustoExecutionStartAdmissionResult<T> | undefined {
	return input && (typeof input === 'object' || typeof input === 'function')
		? cache.get(input as object)
		: undefined;
}

function cacheAdmission<T>(
	cache: WeakMap<object, KustoExecutionStartAdmissionResult<T>>,
	input: unknown,
	admission: KustoExecutionStartAdmissionResult<T>,
): KustoExecutionStartAdmissionResult<T> {
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
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => KustoExecutionStartParseResult<T>,
	cache: WeakMap<object, KustoExecutionStartAdmissionResult<T>>,
): KustoExecutionStartAdmissionResult<T> {
	const type = descriptorValue(getDescriptor(snapshot.descriptors, 'type'));
	if (typeof type === 'string' && !types.has(type)) return { recognized: false };
	if (isRuntimeProxy(snapshot.input)) {
		return cacheAdmission(cache, snapshot.input, {
			recognized: true,
			parsed: failure('Kusto execution-start message must not be a proxy.'),
		});
	}
	const cached = getCachedAdmission(cache, snapshot.input);
	if (cached) return cached;
	return cacheAdmission(
		cache,
		snapshot.input,
		{
			recognized: true,
			parsed: typeof type === 'string' ? parser(snapshot) : failure('type must be a string.'),
		},
	);
}

function admitInput<T>(
	input: unknown,
	types: ReadonlySet<string>,
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => KustoExecutionStartParseResult<T>,
	cache: WeakMap<object, KustoExecutionStartAdmissionResult<T>>,
): KustoExecutionStartAdmissionResult<T> {
	const cached = getCachedAdmission(cache, input);
	if (cached) return cached;
	if (isRuntimeProxy(input)) {
		return cacheAdmission(cache, input, {
			recognized: true,
			parsed: failure('Kusto execution-start message must not be a proxy.'),
		});
	}
	const snapshot = getSnapshot(input);
	if (!snapshot.ok) {
		return inspectKnownType(input, types)
			? { recognized: true, parsed: snapshot }
			: { recognized: false };
	}
	return admitFromEnvelope(snapshot.value, types, parser, cache);
}

export function createKustoExecutionStartedMessage(
	reservation: KustoExecutionReservation,
	query: unknown,
	expectedPredecessorExecutionId?: unknown,
): KustoExecutionStartParseResult<KustoExecutionStartedMessage> {
	const captured = captureReservationForConstruction(reservation);
	if (!captured.ok) return captured;
	if (typeof query !== 'string') return failure('query must be a string.');
	if (expectedPredecessorExecutionId !== undefined
		&& (typeof expectedPredecessorExecutionId !== 'string' || !expectedPredecessorExecutionId.trim())) {
		return failure('expectedPredecessorExecutionId must be a nonblank string when provided.');
	}
	const value = captured.value;
	return parseKustoExecutionStartHostMessage({
		type: 'kustoExecutionStarted',
		engine: value.engine,
		boxId: value.boxId,
		sectionInstanceId: value.sectionInstanceId,
		targetGeneration: value.targetGeneration,
		connectionId: value.connectionId,
		database: value.database,
		executionId: value.executionId,
		producer: value.producer,
		reservationSequence: value.reservationSequence,
		...(value.copilotRequestId ? { copilotRequestId: value.copilotRequestId } : {}),
		...(value.comparisonRun ? { comparisonRun: value.comparisonRun } : {}),
		query,
		...(expectedPredecessorExecutionId !== undefined ? { expectedPredecessorExecutionId } : {}),
	});
}

export function createKustoExecutionStartedAckMessage(
	boxId: unknown,
	executionId: unknown,
	sectionInstanceId: unknown,
	targetGeneration: unknown,
	accepted: unknown,
): KustoExecutionStartParseResult<KustoExecutionStartedAckMessage> {
	return parseKustoExecutionStartWebviewMessage({
		type: 'kustoExecutionStartedAck',
		boxId,
		executionId,
		sectionInstanceId,
		targetGeneration,
		accepted,
	});
}

export function admitKustoExecutionStartHostMessage(
	input: unknown,
): KustoExecutionStartAdmissionResult<KustoExecutionStartHostMessage> {
	return admitInput(input, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitKustoExecutionStartHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoExecutionStartAdmissionResult<KustoExecutionStartHostMessage> {
	return admitFromEnvelope(snapshot, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitKustoExecutionStartWebviewMessage(
	input: unknown,
): KustoExecutionStartAdmissionResult<KustoExecutionStartWebviewMessage> {
	return admitInput(input, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function admitKustoExecutionStartWebviewMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoExecutionStartAdmissionResult<KustoExecutionStartWebviewMessage> {
	return admitFromEnvelope(snapshot, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function parseKustoExecutionStartHostMessage(
	input: unknown,
): KustoExecutionStartParseResult<KustoExecutionStartHostMessage> {
	const admission = admitKustoExecutionStartHostMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown Kusto execution-start host message type.');
}

export function parseKustoExecutionStartWebviewMessage(
	input: unknown,
): KustoExecutionStartParseResult<KustoExecutionStartWebviewMessage> {
	const admission = admitKustoExecutionStartWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Kusto execution-start acknowledgement type.');
}