import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope';

export type PowerBiPublishParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type PowerBiPublishAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: PowerBiPublishParseResult<T> }>;

export type PublishToPowerBISuccessResultMessage = Readonly<{
	type: 'publishToPowerBIResult';
	requestId: string;
	boxId: string;
	ok: true;
	reportUrl: string;
	scheduleConfigured: boolean;
	initialRefreshTriggered?: boolean;
	dataMode: 'import' | 'directQuery';
	semanticModelId: string;
	reportId: string;
	workspaceId: string;
	reportName: string;
	workspaceName?: string;
}>;

export type PublishToPowerBIFailureResultMessage = Readonly<{
	type: 'publishToPowerBIResult';
	requestId: string;
	boxId: string;
	ok: false;
	error: string;
}>;

export type PublishToPowerBIResultMessage =
	| PublishToPowerBISuccessResultMessage
	| PublishToPowerBIFailureResultMessage;

export type PublishToPowerBIAckMessage = Readonly<{
	type: 'publishToPowerBIAck';
	requestId: string;
	accepted: boolean;
}>;

export type PowerBiPublishHostMessage = PublishToPowerBIResultMessage;
export type PowerBiPublishWebviewMessage = PublishToPowerBIAckMessage;

const hostTypes = new Set(['publishToPowerBIResult']);
const webviewTypes = new Set(['publishToPowerBIAck']);
const hostAdmissionCache = new WeakMap<object, PowerBiPublishAdmissionResult<PowerBiPublishHostMessage>>();
const webviewAdmissionCache = new WeakMap<object, PowerBiPublishAdmissionResult<PowerBiPublishWebviewMessage>>();

function failure<T>(error: string): PowerBiPublishParseResult<T> {
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
	return Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
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
): PowerBiPublishParseResult<RuntimeMessageEnvelopeDescriptorSnapshot> {
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (existing) return { ok: true, value: existing };
	if (isRuntimeProxy(input)) return failure('Power BI publish message must not be a proxy.');
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
): PowerBiPublishParseResult<string> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	if (typeof descriptor.value !== 'string' || (nonblank && !descriptor.value.trim())) {
		return failure(`${key} must be ${nonblank ? 'a nonblank string' : 'a string'}.`);
	}
	return { ok: true, value: descriptor.value };
}

function readOptionalString(
	descriptors: PropertyDescriptorMap,
	key: string,
): PowerBiPublishParseResult<string | undefined> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor) return { ok: true, value: undefined };
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return descriptor.value === undefined || typeof descriptor.value === 'string'
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a string when provided.`);
}

function readRequiredBoolean(
	descriptors: PropertyDescriptorMap,
	key: string,
): PowerBiPublishParseResult<boolean> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return typeof descriptor.value === 'boolean'
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a boolean.`);
}

function readOptionalBoolean(
	descriptors: PropertyDescriptorMap,
	key: string,
): PowerBiPublishParseResult<boolean | undefined> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor) return { ok: true, value: undefined };
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return descriptor.value === undefined || typeof descriptor.value === 'boolean'
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a boolean when provided.`);
}

function parseHostSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): PowerBiPublishParseResult<PowerBiPublishHostMessage> {
	if (!isCanonicalRecordPrototype(snapshot.prototype)) {
		return failure('Power BI publish result must use a canonical object prototype.');
	}
	const type = readRequiredString(snapshot.descriptors, 'type');
	if (!type.ok || type.value !== 'publishToPowerBIResult') {
		return failure('Unknown Power BI publish host message type.');
	}
	const ok = readRequiredBoolean(snapshot.descriptors, 'ok');
	if (!ok.ok) return ok;
	const allowed = ok.value
		? new Set([
			'type', 'requestId', 'boxId', 'ok', 'reportUrl', 'scheduleConfigured',
			'initialRefreshTriggered', 'dataMode', 'semanticModelId', 'reportId',
			'workspaceId', 'reportName', 'workspaceName',
		])
		: new Set(['type', 'requestId', 'boxId', 'ok', 'error']);
	const fieldsError = validateExactFields(snapshot.descriptors, allowed, 'Power BI publish result');
	if (fieldsError) return failure(fieldsError);
	const requestId = readRequiredString(snapshot.descriptors, 'requestId');
	if (!requestId.ok) return requestId;
	const boxId = readRequiredString(snapshot.descriptors, 'boxId');
	if (!boxId.ok) return boxId;
	if (!ok.value) {
		const error = readRequiredString(snapshot.descriptors, 'error', false);
		if (!error.ok) return error;
		return {
			ok: true,
			value: Object.freeze({
				type: 'publishToPowerBIResult', requestId: requestId.value,
				boxId: boxId.value, ok: false, error: error.value,
			}),
		};
	}

	const reportUrl = readRequiredString(snapshot.descriptors, 'reportUrl');
	if (!reportUrl.ok) return reportUrl;
	const scheduleConfigured = readRequiredBoolean(snapshot.descriptors, 'scheduleConfigured');
	if (!scheduleConfigured.ok) return scheduleConfigured;
	const initialRefreshTriggered = readOptionalBoolean(snapshot.descriptors, 'initialRefreshTriggered');
	if (!initialRefreshTriggered.ok) return initialRefreshTriggered;
	const dataMode = readRequiredString(snapshot.descriptors, 'dataMode');
	if (!dataMode.ok || (dataMode.value !== 'import' && dataMode.value !== 'directQuery')) {
		return failure('dataMode must be import or directQuery.');
	}
	const semanticModelId = readRequiredString(snapshot.descriptors, 'semanticModelId');
	if (!semanticModelId.ok) return semanticModelId;
	const reportId = readRequiredString(snapshot.descriptors, 'reportId');
	if (!reportId.ok) return reportId;
	const workspaceId = readRequiredString(snapshot.descriptors, 'workspaceId');
	if (!workspaceId.ok) return workspaceId;
	const reportName = readRequiredString(snapshot.descriptors, 'reportName');
	if (!reportName.ok) return reportName;
	const workspaceName = readOptionalString(snapshot.descriptors, 'workspaceName');
	if (!workspaceName.ok) return workspaceName;
	return {
		ok: true,
		value: Object.freeze({
			type: 'publishToPowerBIResult', requestId: requestId.value,
			boxId: boxId.value, ok: true, reportUrl: reportUrl.value,
			scheduleConfigured: scheduleConfigured.value,
			...(getDescriptor(snapshot.descriptors, 'initialRefreshTriggered')
				? { initialRefreshTriggered: initialRefreshTriggered.value }
				: {}),
			dataMode: dataMode.value, semanticModelId: semanticModelId.value,
			reportId: reportId.value, workspaceId: workspaceId.value,
			reportName: reportName.value,
			...(getDescriptor(snapshot.descriptors, 'workspaceName')
				? { workspaceName: workspaceName.value }
				: {}),
		}),
	};
}

function parseWebviewSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): PowerBiPublishParseResult<PowerBiPublishWebviewMessage> {
	if (!isCanonicalRecordPrototype(snapshot.prototype)) {
		return failure('Power BI publish acknowledgement must use a canonical object prototype.');
	}
	const fieldsError = validateExactFields(
		snapshot.descriptors,
		new Set(['type', 'requestId', 'accepted']),
		'Power BI publish acknowledgement',
	);
	if (fieldsError) return failure(fieldsError);
	const type = readRequiredString(snapshot.descriptors, 'type');
	if (!type.ok || type.value !== 'publishToPowerBIAck') {
		return failure('Unknown Power BI publish acknowledgement type.');
	}
	const requestId = readRequiredString(snapshot.descriptors, 'requestId');
	if (!requestId.ok) return requestId;
	const accepted = readRequiredBoolean(snapshot.descriptors, 'accepted');
	if (!accepted.ok) return accepted;
	return {
		ok: true,
		value: Object.freeze({
			type: 'publishToPowerBIAck', requestId: requestId.value, accepted: accepted.value,
		}),
	};
}

function getCachedAdmission<T>(
	cache: WeakMap<object, PowerBiPublishAdmissionResult<T>>,
	input: unknown,
): PowerBiPublishAdmissionResult<T> | undefined {
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
	return cache.get(input as object);
}

function cacheAdmission<T>(
	cache: WeakMap<object, PowerBiPublishAdmissionResult<T>>,
	input: unknown,
	admission: PowerBiPublishAdmissionResult<T>,
): PowerBiPublishAdmissionResult<T> {
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
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => PowerBiPublishParseResult<T>,
	cache: WeakMap<object, PowerBiPublishAdmissionResult<T>>,
): PowerBiPublishAdmissionResult<T> {
	const type = descriptorValue(getDescriptor(snapshot.descriptors, 'type'));
	if (typeof type === 'string' && !types.has(type)) return { recognized: false };
	if (isRuntimeProxy(snapshot.input)) {
		return cacheAdmission(cache, snapshot.input, {
			recognized: true,
			parsed: failure('Power BI publish message must not be a proxy.'),
		});
	}
	const cached = getCachedAdmission(cache, snapshot.input);
	if (cached) return cached;
	return cacheAdmission(cache, snapshot.input, {
		recognized: true,
		parsed: typeof type === 'string' ? parser(snapshot) : failure('type must be a string.'),
	});
}

function admitInput<T>(
	input: unknown,
	types: ReadonlySet<string>,
	parser: (snapshot: RuntimeMessageEnvelopeDescriptorSnapshot) => PowerBiPublishParseResult<T>,
	cache: WeakMap<object, PowerBiPublishAdmissionResult<T>>,
): PowerBiPublishAdmissionResult<T> {
	const cached = getCachedAdmission(cache, input);
	if (cached) return cached;
	if (isRuntimeProxy(input)) {
		return cacheAdmission(cache, input, {
			recognized: true,
			parsed: failure('Power BI publish message must not be a proxy.'),
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

export function createPublishToPowerBISuccessResultMessage(
	requestId: unknown,
	boxId: unknown,
	reportUrl: unknown,
	scheduleConfigured: unknown,
	initialRefreshTriggered: unknown,
	dataMode: unknown,
	semanticModelId: unknown,
	reportId: unknown,
	workspaceId: unknown,
	reportName: unknown,
	workspaceName?: unknown,
): PowerBiPublishParseResult<PublishToPowerBISuccessResultMessage> {
	const parsed = parsePowerBiPublishHostMessage({
		type: 'publishToPowerBIResult', requestId, boxId, ok: true, reportUrl,
		scheduleConfigured, initialRefreshTriggered, dataMode, semanticModelId,
		reportId, workspaceId, reportName, workspaceName,
	});
	if (!parsed.ok) return parsed;
	return parsed.value.ok
		? { ok: true, value: parsed.value }
		: failure('Expected a successful Power BI publish result.');
}

export function createPublishToPowerBIFailureResultMessage(
	requestId: unknown,
	boxId: unknown,
	error: unknown,
): PowerBiPublishParseResult<PublishToPowerBIFailureResultMessage> {
	const parsed = parsePowerBiPublishHostMessage({
		type: 'publishToPowerBIResult', requestId, boxId, ok: false, error,
	});
	if (!parsed.ok) return parsed;
	return !parsed.value.ok
		? { ok: true, value: parsed.value }
		: failure('Expected a failed Power BI publish result.');
}

export function createPublishToPowerBIAckMessage(
	requestId: unknown,
	accepted: unknown,
): PowerBiPublishParseResult<PublishToPowerBIAckMessage> {
	return parsePowerBiPublishWebviewMessage({ type: 'publishToPowerBIAck', requestId, accepted });
}

export function admitPowerBiPublishHostMessage(
	input: unknown,
): PowerBiPublishAdmissionResult<PowerBiPublishHostMessage> {
	return admitInput(input, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitPowerBiPublishHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): PowerBiPublishAdmissionResult<PowerBiPublishHostMessage> {
	return admitFromEnvelope(snapshot, hostTypes, parseHostSnapshot, hostAdmissionCache);
}

export function admitPowerBiPublishWebviewMessage(
	input: unknown,
): PowerBiPublishAdmissionResult<PowerBiPublishWebviewMessage> {
	return admitInput(input, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function admitPowerBiPublishWebviewMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): PowerBiPublishAdmissionResult<PowerBiPublishWebviewMessage> {
	return admitFromEnvelope(snapshot, webviewTypes, parseWebviewSnapshot, webviewAdmissionCache);
}

export function parsePowerBiPublishHostMessage(
	input: unknown,
): PowerBiPublishParseResult<PowerBiPublishHostMessage> {
	const admission = admitPowerBiPublishHostMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown Power BI publish host message type.');
}

export function parsePowerBiPublishWebviewMessage(
	input: unknown,
): PowerBiPublishParseResult<PowerBiPublishWebviewMessage> {
	const admission = admitPowerBiPublishWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown Power BI publish acknowledgement type.');
}