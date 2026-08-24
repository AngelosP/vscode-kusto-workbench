import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
} from './runtimeMessageEnvelope';

export const SQL_COPILOT_PERSIST_ACK_TIMEOUT_MS = 15_000;
export const SQL_COPILOT_START_ACK_TIMEOUT_MS = 20_000;
export const SQL_COPILOT_START_RETIREMENT_TTL_MS = 30_000;

export type SqlCopilotExecutionStartAck = Readonly<{
	type: 'copilotWriteQueryExecutionAck';
	boxId: string;
	executionId: string;
	accepted: boolean;
}>;

export type SqlCopilotExecutionStartAckParseResult =
	| Readonly<{ ok: true; value: SqlCopilotExecutionStartAck }>
	| Readonly<{ ok: false; error: string }>;

function canonicalNonblankString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function parseSqlCopilotExecutionStartAck(
	input: unknown,
): SqlCopilotExecutionStartAckParseResult {
	if (isRuntimeProxy(input)) {
		return { ok: false, error: 'SQL Copilot start acknowledgement must not be a proxy.' };
	}
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	const envelope = existing
		? { ok: true as const, value: input as Record<string, unknown> & { type: string }, descriptorSnapshot: existing }
		: captureRuntimeMessageEnvelope(input);
	if (!envelope.ok || envelope.value.type !== 'copilotWriteQueryExecutionAck') {
		return { ok: false, error: 'SQL Copilot start acknowledgement type is invalid.' };
	}
	if (isRuntimeProxy(envelope.descriptorSnapshot.input)) {
		return { ok: false, error: 'SQL Copilot start acknowledgement must not be a proxy.' };
	}
	if (envelope.descriptorSnapshot.prototype !== null
		&& envelope.descriptorSnapshot.prototype !== Object.prototype) {
		return { ok: false, error: 'SQL Copilot start acknowledgement prototype is invalid.' };
	}
	const keys = Reflect.ownKeys(envelope.descriptorSnapshot.descriptors);
	const expected = new Set(['type', 'boxId', 'executionId', 'accepted']);
	if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
		return { ok: false, error: 'SQL Copilot start acknowledgement fields are invalid.' };
	}
	const message = envelope.value;
	if (!canonicalNonblankString(message.boxId) || !canonicalNonblankString(message.executionId)
		|| typeof message.accepted !== 'boolean') {
		return { ok: false, error: 'SQL Copilot start acknowledgement identity is invalid.' };
	}
	return {
		ok: true,
		value: Object.freeze({
			type: 'copilotWriteQueryExecutionAck',
			boxId: message.boxId,
			executionId: message.executionId,
			accepted: message.accepted,
		}),
	};
}