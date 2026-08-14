import type { RuntimeMessageEnvelopeDescriptorSnapshot } from './runtimeMessageEnvelope';

type UnknownRecord = Record<string, unknown>;

export type KustoPublicationParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoPublicationAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: KustoPublicationParseResult<T> }>;

export type KustoPublicationStageMessage = Readonly<{
	type: 'kustoPublicationStage';
	publicationId: string;
	publicationDeadline: number;
	payload: Readonly<Record<string, unknown>>;
}>;

export type KustoPublicationAckMessage = Readonly<{
	type: 'kustoPublicationAck';
	publicationId: string;
	phase: 'staged' | 'applied';
	accepted: boolean;
}>;

export type KustoPublicationCommitMessage = Readonly<{
	type: 'kustoPublicationCommit';
	publicationId: string;
}>;

export type KustoPublicationRevokeMessage = Readonly<{
	type: 'kustoPublicationRevoke';
	publicationId: string;
}>;

export type KustoPublicationHostMessage =
	| KustoPublicationStageMessage
	| KustoPublicationCommitMessage
	| KustoPublicationRevokeMessage;

export type KustoPublicationWebviewMessage = KustoPublicationAckMessage;

type DescriptorSnapshot = Readonly<{
	input: UnknownRecord;
	descriptors: PropertyDescriptorMap;
}>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{
		recognized: true;
		type: KustoPublicationParseResult<string>;
		snapshot?: DescriptorSnapshot;
	}>;

const hostMessageTypes = new Set([
	'kustoPublicationStage',
	'kustoPublicationCommit',
	'kustoPublicationRevoke',
]);
const webviewMessageTypes = new Set(['kustoPublicationAck']);

function failure<T>(error: string): KustoPublicationParseResult<T> {
	return { ok: false, error };
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function inspectKnownTypeSnapshot(
	snapshot: DescriptorSnapshot,
	types: ReadonlySet<string>,
): KnownTypeInspection {
	const input = snapshot.input;
	try {
		const typeDescriptor = Object.getOwnPropertyDescriptor(snapshot.descriptors, 'type')?.value as PropertyDescriptor | undefined;
		if (typeDescriptor) {
			const value = descriptorValue(typeDescriptor);
			if (typeof value === 'string' && !types.has(value)) return { recognized: false };
			if (!typeDescriptor.enumerable || !Object.prototype.hasOwnProperty.call(typeDescriptor, 'value')) {
				return {
					recognized: true,
					type: failure('type must be an own enumerable data property.'),
					snapshot,
				};
			}
			return {
				recognized: true,
				type: typeof value === 'string' ? { ok: true, value } : failure('type must be a string.'),
				snapshot,
			};
		}

		let owner = input as object | null;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) {
				return { recognized: true, type: failure('type prototype inspection was cyclic.'), snapshot };
			}
			seen.add(owner);
			const inherited = owner === input ? undefined : Object.getOwnPropertyDescriptor(owner, 'type');
			if (inherited) {
				const value = descriptorValue(inherited);
				if (typeof value === 'string' && !types.has(value)) return { recognized: false };
				return {
					recognized: true,
					type: failure('type must be an own enumerable data property.'),
					snapshot,
				};
			}
			owner = Object.getPrototypeOf(owner);
		}
		return {
			recognized: true,
			type: failure(owner ? 'type prototype inspection exceeded its bound.' : 'type could not be resolved.'),
			snapshot,
		};
	} catch {
		return { recognized: true, type: failure('type could not be inspected.') };
	}
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): KnownTypeInspection {
	const inputType = typeof input;
	if (!input || (inputType !== 'object' && inputType !== 'function')) return { recognized: false };
	try {
		return inspectKnownTypeSnapshot({
			input: input as UnknownRecord,
			descriptors: Object.getOwnPropertyDescriptors(input),
		}, types);
	} catch {
		return { recognized: true, type: failure('type could not be inspected.') };
	}
}

function inspectRuntimeEnvelopeSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
	types: ReadonlySet<string>,
): KnownTypeInspection {
	return inspectKnownTypeSnapshot({
		input: snapshot.input as UnknownRecord,
		descriptors: snapshot.descriptors,
	}, types);
}

function validateExactRecord(
	snapshot: DescriptorSnapshot,
	allowedKeys: ReadonlySet<string>,
	label: string,
): KustoPublicationParseResult<DescriptorSnapshot> {
	try {
		if (typeof snapshot.input === 'function' || Array.isArray(snapshot.input)) {
			return failure(`${label} must be an object record.`);
		}
		const prototype = Object.getPrototypeOf(snapshot.input);
		if (prototype !== Object.prototype && prototype !== null) {
			return failure(`${label} must use a canonical object prototype.`);
		}
		const keys = Reflect.ownKeys(snapshot.descriptors);
		if (keys.length !== allowedKeys.size) return failure(`${label} must contain only canonical fields.`);
		for (const key of keys) {
			if (typeof key !== 'string' || !allowedKeys.has(key)) {
				return failure(`${label} must contain only canonical fields.`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(snapshot.descriptors, key)?.value as PropertyDescriptor | undefined;
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be an own enumerable data property.`);
			}
		}
		return { ok: true, value: snapshot };
	} catch {
		return failure(`${label} could not be inspected.`);
	}
}

function readValue(snapshot: DescriptorSnapshot, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(snapshot.descriptors, key)?.value as PropertyDescriptor;
	return descriptor.value;
}

function readPublicationId(snapshot: DescriptorSnapshot): KustoPublicationParseResult<string> {
	const value = readValue(snapshot, 'publicationId');
	return typeof value === 'string' && value.trim().length > 0
		? { ok: true, value }
		: failure('publicationId must be a nonblank string.');
}

function capturePayload(input: unknown, envelope: UnknownRecord): KustoPublicationParseResult<Readonly<Record<string, unknown>>> {
	if (!input || typeof input !== 'object') return failure('payload must be an object record.');
	try {
		if (Array.isArray(input)) return failure('payload must be an object record.');
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) {
			return failure('payload must use a canonical object prototype.');
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const captured: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== 'string') return failure('payload must contain only string fields.');
			const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined;
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure('payload fields must be own enumerable data properties.');
			}
			if (descriptor.value === input || descriptor.value === envelope) {
				return failure('payload must not be cyclic.');
			}
			Object.defineProperty(captured, key, {
				value: descriptor.value,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return { ok: true, value: Object.freeze(captured) };
	} catch {
		return failure('payload could not be inspected.');
	}
}

function parseHostMessage(
	inspection: Extract<KnownTypeInspection, { recognized: true }>,
): KustoPublicationParseResult<KustoPublicationHostMessage> {
	if (!inspection.type.ok) return inspection.type;
	if (!inspection.snapshot) return failure('Kusto publication host message could not be captured.');
	const { type, snapshot } = inspection;
	const allowedKeys = type.value === 'kustoPublicationStage'
		? new Set(['type', 'publicationId', 'publicationDeadline', 'payload'])
		: new Set(['type', 'publicationId']);
	const record = validateExactRecord(snapshot, allowedKeys, 'Kusto publication host message');
	if (!record.ok) return record;
	const publicationId = readPublicationId(snapshot);
	if (!publicationId.ok) return publicationId;
	if (type.value === 'kustoPublicationStage') {
		const publicationDeadline = readValue(snapshot, 'publicationDeadline');
		if (typeof publicationDeadline !== 'number' || !Number.isFinite(publicationDeadline)) {
			return failure('publicationDeadline must be a finite number.');
		}
		const payload = capturePayload(readValue(snapshot, 'payload'), snapshot.input);
		if (!payload.ok) return payload;
		return {
			ok: true,
			value: Object.freeze({
				type: 'kustoPublicationStage',
				publicationId: publicationId.value,
				publicationDeadline,
				payload: payload.value,
			}),
		};
	}
	if (type.value === 'kustoPublicationCommit') {
		return { ok: true, value: Object.freeze({ type: 'kustoPublicationCommit', publicationId: publicationId.value }) };
	}
	if (type.value === 'kustoPublicationRevoke') {
		return { ok: true, value: Object.freeze({ type: 'kustoPublicationRevoke', publicationId: publicationId.value }) };
	}
	return failure('Unknown Kusto publication host message type.');
}

function parseWebviewMessage(
	inspection: Extract<KnownTypeInspection, { recognized: true }>,
): KustoPublicationParseResult<KustoPublicationWebviewMessage> {
	if (!inspection.type.ok) return inspection.type;
	if (!inspection.snapshot) return failure('Kusto publication acknowledgement could not be captured.');
	const record = validateExactRecord(
		inspection.snapshot,
		new Set(['type', 'publicationId', 'phase', 'accepted']),
		'Kusto publication acknowledgement',
	);
	if (!record.ok) return record;
	const publicationId = readPublicationId(inspection.snapshot);
	if (!publicationId.ok) return publicationId;
	const phase = readValue(inspection.snapshot, 'phase');
	if (phase !== 'staged' && phase !== 'applied') {
		return failure('phase must be staged or applied.');
	}
	const accepted = readValue(inspection.snapshot, 'accepted');
	if (typeof accepted !== 'boolean') return failure('accepted must be a boolean.');
	return {
		ok: true,
		value: Object.freeze({
			type: 'kustoPublicationAck',
			publicationId: publicationId.value,
			phase,
			accepted,
		}),
	};
}

export function isKustoPublicationHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function isKustoPublicationWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function admitKustoPublicationHostMessage(
	input: unknown,
): KustoPublicationAdmissionResult<KustoPublicationHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseHostMessage(inspection) };
}

export function admitKustoPublicationWebviewMessage(
	input: unknown,
): KustoPublicationAdmissionResult<KustoPublicationWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseWebviewMessage(inspection) };
}

export function parseKustoPublicationHostMessage(
	input: unknown,
): KustoPublicationParseResult<KustoPublicationHostMessage> {
	const admission = admitKustoPublicationHostMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown Kusto publication host message type.');
}

export function parseKustoPublicationWebviewMessage(
	input: unknown,
): KustoPublicationParseResult<KustoPublicationWebviewMessage> {
	const admission = admitKustoPublicationWebviewMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown Kusto publication acknowledgement type.');
}

export function admitKustoPublicationHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoPublicationAdmissionResult<KustoPublicationHostMessage> {
	const inspection = inspectRuntimeEnvelopeSnapshot(snapshot, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseHostMessage(inspection) };
}

export function admitKustoPublicationWebviewMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoPublicationAdmissionResult<KustoPublicationWebviewMessage> {
	const inspection = inspectRuntimeEnvelopeSnapshot(snapshot, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return { recognized: true, parsed: parseWebviewMessage(inspection) };
}