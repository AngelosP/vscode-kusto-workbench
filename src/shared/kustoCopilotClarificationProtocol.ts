import type { KustoCopilotRequestIdentity } from './kustoExecution';
import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope';

export type KustoCopilotClarificationParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type KustoCopilotClarificationResponseTarget = 'section-chat' | 'calling-agent';

export type KustoCopilotClarifyingQuestionMessage = Readonly<KustoCopilotRequestIdentity & {
	type: 'copilotClarifyingQuestion';
	entryId: string;
	question: string;
	responseTarget: KustoCopilotClarificationResponseTarget;
}>;

export type KustoCopilotClarificationRequiredResult = Readonly<{
	outcome: 'clarification-required';
	success: false;
	question: string;
	sectionId: string;
}>;

function failure<T>(error: string): KustoCopilotClarificationParseResult<T> {
	return { ok: false, error };
}

function getDescriptor(
	descriptors: PropertyDescriptorMap,
	key: string,
): PropertyDescriptor | undefined {
	return Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function getSnapshot(
	input: unknown,
): KustoCopilotClarificationParseResult<RuntimeMessageEnvelopeDescriptorSnapshot> {
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (existing) return { ok: true, value: existing };
	if (isRuntimeProxy(input)) return failure('Kusto Copilot clarification must not be a proxy.');
	const captured = captureRuntimeMessageEnvelope(input);
	return captured.ok ? { ok: true, value: captured.descriptorSnapshot } : captured;
}

function getRecordSnapshot(
	input: unknown,
): KustoCopilotClarificationParseResult<RuntimeMessageEnvelopeDescriptorSnapshot> {
	if (!input || typeof input !== 'object') {
		return failure('Kusto Copilot clarification result must be an object.');
	}
	if (isRuntimeProxy(input)) return failure('Kusto Copilot clarification result must not be a proxy.');
	try {
		if (Array.isArray(input)) {
			return failure('Kusto Copilot clarification result must be an object.');
		}
		return {
			ok: true,
			value: {
				input,
				descriptors: Object.getOwnPropertyDescriptors(input),
				prototype: Object.getPrototypeOf(input),
			},
		};
	} catch {
		return failure('Kusto Copilot clarification result could not be captured.');
	}
}

function validateSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
	allowedFields: ReadonlySet<string>,
	label: string,
): string | undefined {
	if (isRuntimeProxy(snapshot.input)) return `${label} must not be a proxy.`;
	if (snapshot.prototype !== Object.prototype && snapshot.prototype !== null) {
		return `${label} must use a canonical object prototype.`;
	}
	for (const key of Reflect.ownKeys(snapshot.descriptors)) {
		if (typeof key !== 'string' || !allowedFields.has(key)) {
			return `${label} contains an unsupported field.`;
		}
		const descriptor = getDescriptor(snapshot.descriptors, key);
		if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return `${label} fields must be own enumerable data properties.`;
		}
	}
	return undefined;
}

function readString(
	descriptors: PropertyDescriptorMap,
	key: string,
	nonblank = true,
): KustoCopilotClarificationParseResult<string> {
	const descriptor = getDescriptor(descriptors, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	if (typeof descriptor.value !== 'string' || (nonblank && !descriptor.value.trim())) {
		return failure(`${key} must be ${nonblank ? 'a nonblank string' : 'a string'}.`);
	}
	return { ok: true, value: descriptor.value };
}

function readSafeGeneration(
	descriptors: PropertyDescriptorMap,
): KustoCopilotClarificationParseResult<number> {
	const descriptor = getDescriptor(descriptors, 'targetGeneration');
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure('targetGeneration must be an own enumerable data property.');
	}
	return Number.isSafeInteger(descriptor.value) && Number(descriptor.value) >= 0
		? { ok: true, value: Number(descriptor.value) }
		: failure('targetGeneration must be a non-negative safe integer.');
}

function parseClarifyingQuestionSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoCopilotClarificationParseResult<KustoCopilotClarifyingQuestionMessage> {
	const fieldsError = validateSnapshot(snapshot, new Set([
		'type', 'boxId', 'copilotRequestId', 'sectionInstanceId', 'targetGeneration',
		'entryId', 'question', 'responseTarget',
	]), 'Kusto Copilot clarification');
	if (fieldsError) return failure(fieldsError);
	const type = readString(snapshot.descriptors, 'type');
	if (!type.ok || type.value !== 'copilotClarifyingQuestion') {
		return failure('Unknown Kusto Copilot clarification type.');
	}
	const boxId = readString(snapshot.descriptors, 'boxId');
	if (!boxId.ok) return boxId;
	const copilotRequestId = readString(snapshot.descriptors, 'copilotRequestId');
	if (!copilotRequestId.ok) return copilotRequestId;
	const sectionInstanceId = readString(snapshot.descriptors, 'sectionInstanceId');
	if (!sectionInstanceId.ok) return sectionInstanceId;
	const targetGeneration = readSafeGeneration(snapshot.descriptors);
	if (!targetGeneration.ok) return targetGeneration;
	const entryId = readString(snapshot.descriptors, 'entryId');
	if (!entryId.ok) return entryId;
	const question = readString(snapshot.descriptors, 'question');
	if (!question.ok) return question;
	const responseTarget = readString(snapshot.descriptors, 'responseTarget');
	if (!responseTarget.ok
		|| (responseTarget.value !== 'section-chat' && responseTarget.value !== 'calling-agent')) {
		return failure('responseTarget must be section-chat or calling-agent.');
	}
	return {
		ok: true,
		value: Object.freeze({
			type: 'copilotClarifyingQuestion',
			boxId: boxId.value,
			copilotRequestId: copilotRequestId.value,
			sectionInstanceId: sectionInstanceId.value,
			targetGeneration: targetGeneration.value,
			entryId: entryId.value,
			question: question.value,
			responseTarget: responseTarget.value,
		}),
	};
}

function parseRequiredResultSnapshot(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoCopilotClarificationParseResult<KustoCopilotClarificationRequiredResult> {
	const fieldsError = validateSnapshot(
		snapshot,
		new Set(['outcome', 'success', 'question', 'sectionId']),
		'Kusto Copilot clarification result',
	);
	if (fieldsError) return failure(fieldsError);
	const outcome = readString(snapshot.descriptors, 'outcome');
	if (!outcome.ok || outcome.value !== 'clarification-required') {
		return failure('outcome must be clarification-required.');
	}
	const successDescriptor = getDescriptor(snapshot.descriptors, 'success');
	if (!successDescriptor?.enumerable
		|| !Object.prototype.hasOwnProperty.call(successDescriptor, 'value')
		|| successDescriptor.value !== false) {
		return failure('success must be false.');
	}
	const question = readString(snapshot.descriptors, 'question');
	if (!question.ok) return question;
	const sectionId = readString(snapshot.descriptors, 'sectionId');
	if (!sectionId.ok) return sectionId;
	return {
		ok: true,
		value: Object.freeze({
			outcome: 'clarification-required', success: false,
			question: question.value, sectionId: sectionId.value,
		}),
	};
}

export function createKustoCopilotClarifyingQuestionMessage(
	identity: KustoCopilotRequestIdentity,
	entryId: unknown,
	question: unknown,
	responseTarget: unknown,
): KustoCopilotClarificationParseResult<KustoCopilotClarifyingQuestionMessage> {
	return parseKustoCopilotClarifyingQuestionMessage({
		type: 'copilotClarifyingQuestion', ...identity, entryId, question, responseTarget,
	});
}

export function parseKustoCopilotClarifyingQuestionMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): KustoCopilotClarificationParseResult<KustoCopilotClarifyingQuestionMessage> {
	return parseClarifyingQuestionSnapshot(snapshot);
}

export function parseKustoCopilotClarifyingQuestionMessage(
	input: unknown,
): KustoCopilotClarificationParseResult<KustoCopilotClarifyingQuestionMessage> {
	const snapshot = getSnapshot(input);
	return snapshot.ok ? parseClarifyingQuestionSnapshot(snapshot.value) : snapshot;
}

export function createKustoCopilotClarificationRequiredResult(
	question: unknown,
	sectionId: unknown,
): KustoCopilotClarificationParseResult<KustoCopilotClarificationRequiredResult> {
	return parseKustoCopilotClarificationRequiredResult({
		outcome: 'clarification-required', success: false, question, sectionId,
	});
}

export function parseKustoCopilotClarificationRequiredResult(
	input: unknown,
): KustoCopilotClarificationParseResult<KustoCopilotClarificationRequiredResult> {
	const snapshot = getRecordSnapshot(input);
	return snapshot.ok ? parseRequiredResultSnapshot(snapshot.value) : snapshot;
}

export function isKustoCopilotClarifyingQuestionType(input: unknown): boolean {
	const snapshot = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (snapshot) return descriptorValue(getDescriptor(snapshot.descriptors, 'type')) === 'copilotClarifyingQuestion';
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) return false;
	try {
		return descriptorValue(Object.getOwnPropertyDescriptor(input, 'type')) === 'copilotClarifyingQuestion';
	} catch {
		return false;
	}
}