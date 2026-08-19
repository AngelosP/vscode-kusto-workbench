import {
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope.js';

type UnknownRecord = Record<string, unknown>;

export type KustoResultAttachmentParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoResultAttachmentCommittedMessage = Readonly<{
	type: 'kustoResultAttachmentCommitted';
	publicationId: string;
	boxId: string;
	executionId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	primaryArtifactId: string;
	resultSetCount: number;
	selectedResultIndex: number;
}>;

export type SelectKustoResultMessage = Readonly<{
	type: 'selectKustoResult';
	requestId: string;
	boxId: string;
	sectionInstanceId: string;
	targetGeneration: number;
	primaryArtifactId: string;
	resultIndex: number;
}>;

export type KustoResultSelectionResultMessage = Readonly<{
	type: 'kustoResultSelectionResult';
	requestId: string;
	boxId: string;
	primaryArtifactId: string;
	resultIndex: number;
	accepted: boolean;
}>;

export type KustoResultAttachmentHostMessage =
	| KustoResultAttachmentCommittedMessage
	| KustoResultSelectionResultMessage;

export type KustoResultAttachmentWebviewMessage = SelectKustoResultMessage;

function failure<T>(error: string): KustoResultAttachmentParseResult<T> {
	return { ok: false, error };
}

function captureExact(
	input: unknown,
	type: string,
	keys: readonly string[],
	snapshot?: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<Readonly<UnknownRecord>> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return failure('Kusto result attachment message must be an object record.');
	}
	try {
		const envelopeSnapshot = snapshot ?? getRuntimeMessageEnvelopeDescriptorSnapshot(input);
		const inspectedInput = envelopeSnapshot?.input ?? input;
		const prototype = envelopeSnapshot?.prototype ?? Object.getPrototypeOf(inspectedInput);
		if (prototype !== Object.prototype && prototype !== null) {
			return failure('Kusto result attachment message must use a canonical prototype.');
		}
		const descriptors = envelopeSnapshot?.descriptors ?? Object.getOwnPropertyDescriptors(inspectedInput);
		const actualKeys = Reflect.ownKeys(descriptors);
		if (actualKeys.length !== keys.length || actualKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
			return failure('Kusto result attachment message must contain only canonical fields.');
		}
		const captured: UnknownRecord = {};
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be an own enumerable data property.`);
			}
			captured[key] = descriptor.value;
		}
		if (captured.type !== type) return failure(`Expected ${type}.`);
		return { ok: true, value: Object.freeze(captured) };
	} catch {
		return failure('Kusto result attachment message could not be inspected.');
	}
}

function readString(record: Readonly<UnknownRecord>, key: string): KustoResultAttachmentParseResult<string> {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 && value.length <= 4096
		? { ok: true, value }
		: failure(`${key} must be a bounded nonblank string.`);
}

function readIndex(record: Readonly<UnknownRecord>, key: string, positive = false): KustoResultAttachmentParseResult<number> {
	const value = record[key];
	return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0)
		? { ok: true, value: Number(value) }
		: failure(`${key} must be a ${positive ? 'positive' : 'non-negative'} safe integer.`);
}

function parseCommitted(
	input: unknown,
	snapshot?: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<KustoResultAttachmentCommittedMessage> {
	const captured = captureExact(input, 'kustoResultAttachmentCommitted', [
		'type', 'publicationId', 'boxId', 'executionId', 'sectionInstanceId',
		'targetGeneration', 'primaryArtifactId', 'resultSetCount', 'selectedResultIndex',
	], snapshot);
	if (!captured.ok) return captured;
	const publicationId = readString(captured.value, 'publicationId');
	const boxId = readString(captured.value, 'boxId');
	const executionId = readString(captured.value, 'executionId');
	const sectionInstanceId = readString(captured.value, 'sectionInstanceId');
	const targetGeneration = readIndex(captured.value, 'targetGeneration');
	const primaryArtifactId = readString(captured.value, 'primaryArtifactId');
	const resultSetCount = readIndex(captured.value, 'resultSetCount', true);
	const selectedResultIndex = readIndex(captured.value, 'selectedResultIndex');
	if (!publicationId.ok) return publicationId;
	if (!boxId.ok) return boxId;
	if (!executionId.ok) return executionId;
	if (!sectionInstanceId.ok) return sectionInstanceId;
	if (!targetGeneration.ok) return targetGeneration;
	if (!primaryArtifactId.ok) return primaryArtifactId;
	if (!resultSetCount.ok) return resultSetCount;
	if (!selectedResultIndex.ok) return selectedResultIndex;
	if (selectedResultIndex.value >= resultSetCount.value) return failure('selectedResultIndex is outside the result set count.');
	return { ok: true, value: Object.freeze({
		type: 'kustoResultAttachmentCommitted',
		publicationId: publicationId.value,
		boxId: boxId.value,
		executionId: executionId.value,
		sectionInstanceId: sectionInstanceId.value,
		targetGeneration: targetGeneration.value,
		primaryArtifactId: primaryArtifactId.value,
		resultSetCount: resultSetCount.value,
		selectedResultIndex: selectedResultIndex.value,
	}) };
}

function parseSelectionRequest(
	input: unknown,
	snapshot?: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<SelectKustoResultMessage> {
	const captured = captureExact(input, 'selectKustoResult', [
		'type', 'requestId', 'boxId', 'sectionInstanceId', 'targetGeneration',
		'primaryArtifactId', 'resultIndex',
	], snapshot);
	if (!captured.ok) return captured;
	const requestId = readString(captured.value, 'requestId');
	const boxId = readString(captured.value, 'boxId');
	const sectionInstanceId = readString(captured.value, 'sectionInstanceId');
	const targetGeneration = readIndex(captured.value, 'targetGeneration');
	const primaryArtifactId = readString(captured.value, 'primaryArtifactId');
	const resultIndex = readIndex(captured.value, 'resultIndex');
	if (!requestId.ok) return requestId;
	if (!boxId.ok) return boxId;
	if (!sectionInstanceId.ok) return sectionInstanceId;
	if (!targetGeneration.ok) return targetGeneration;
	if (!primaryArtifactId.ok) return primaryArtifactId;
	if (!resultIndex.ok) return resultIndex;
	return { ok: true, value: Object.freeze({
		type: 'selectKustoResult', requestId: requestId.value, boxId: boxId.value,
		sectionInstanceId: sectionInstanceId.value, targetGeneration: targetGeneration.value,
		primaryArtifactId: primaryArtifactId.value, resultIndex: resultIndex.value,
	}) };
}

function parseSelectionResult(
	input: unknown,
	snapshot?: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<KustoResultSelectionResultMessage> {
	const captured = captureExact(input, 'kustoResultSelectionResult', [
		'type', 'requestId', 'boxId', 'primaryArtifactId', 'resultIndex', 'accepted',
	], snapshot);
	if (!captured.ok) return captured;
	const requestId = readString(captured.value, 'requestId');
	const boxId = readString(captured.value, 'boxId');
	const primaryArtifactId = readString(captured.value, 'primaryArtifactId');
	const resultIndex = readIndex(captured.value, 'resultIndex');
	if (!requestId.ok) return requestId;
	if (!boxId.ok) return boxId;
	if (!primaryArtifactId.ok) return primaryArtifactId;
	if (!resultIndex.ok) return resultIndex;
	if (typeof captured.value.accepted !== 'boolean') return failure('accepted must be a boolean.');
	return { ok: true, value: Object.freeze({
		type: 'kustoResultSelectionResult', requestId: requestId.value, boxId: boxId.value,
		primaryArtifactId: primaryArtifactId.value, resultIndex: resultIndex.value,
		accepted: captured.value.accepted,
	}) };
}

export function parseKustoResultAttachmentHostMessage(
	input: unknown,
): KustoResultAttachmentParseResult<KustoResultAttachmentHostMessage> {
	if (!input || typeof input !== 'object') return failure('Unknown Kusto result attachment host message.');
	let type: unknown;
	try { type = Object.getOwnPropertyDescriptor(input, 'type')?.value; } catch { return failure('Message type could not be read.'); }
	if (type === 'kustoResultAttachmentCommitted') return parseCommitted(input);
	if (type === 'kustoResultSelectionResult') return parseSelectionResult(input);
	return failure('Unknown Kusto result attachment host message.');
}

export function parseKustoResultAttachmentWebviewMessage(
	input: unknown,
): KustoResultAttachmentParseResult<KustoResultAttachmentWebviewMessage> {
	return parseSelectionRequest(input);
}

export function parseKustoResultAttachmentHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<KustoResultAttachmentHostMessage> {
	const type = snapshot.descriptors.type?.value;
	if (type === 'kustoResultAttachmentCommitted') return parseCommitted(snapshot.input, snapshot);
	if (type === 'kustoResultSelectionResult') return parseSelectionResult(snapshot.input, snapshot);
	return failure('Unknown Kusto result attachment host message.');
}

export function parseKustoResultAttachmentWebviewMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoResultAttachmentParseResult<KustoResultAttachmentWebviewMessage> {
	return parseSelectionRequest(snapshot.input, snapshot);
}

export function createKustoResultAttachmentCommittedMessage(
	input: Omit<KustoResultAttachmentCommittedMessage, 'type'>,
): KustoResultAttachmentParseResult<KustoResultAttachmentCommittedMessage> {
	return parseCommitted({ type: 'kustoResultAttachmentCommitted', ...input });
}

export function createKustoResultSelectionRequest(
	input: Omit<SelectKustoResultMessage, 'type'>,
): KustoResultAttachmentParseResult<SelectKustoResultMessage> {
	return parseSelectionRequest({ type: 'selectKustoResult', ...input });
}

export function createKustoResultSelectionResultMessage(
	input: Omit<KustoResultSelectionResultMessage, 'type'>,
): KustoResultAttachmentParseResult<KustoResultSelectionResultMessage> {
	return parseSelectionResult({ type: 'kustoResultSelectionResult', ...input });
}