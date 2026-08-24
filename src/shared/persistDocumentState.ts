import {
	captureRuntimeMessageEnvelope,
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
} from './runtimeMessageEnvelope';

type UnknownRecord = Record<string, unknown>;

export type PersistDocumentStateCaptureResult =
	| Readonly<{ ok: true; value: UnknownRecord & { sections: UnknownRecord[] } }>
	| Readonly<{ ok: false; error: string }>;

export type PersistDocumentMessage = Readonly<{
	type: 'persistDocument';
	state: UnknownRecord & { sections: UnknownRecord[] };
	sourceGeneration: number;
	snapshotId?: string;
	editRevision?: number;
	flushRequestId?: string;
	flushUnavailableReason?: string;
	flush?: boolean;
	testOnlyNoop?: boolean;
	reason?: string;
	[key: string]: unknown;
}>;

export type PersistDocumentMessageParseResult =
	| Readonly<{ ok: true; value: PersistDocumentMessage }>
	| Readonly<{ ok: false; error: string }>;

type CaptureContext = {
	readonly active: Set<object>;
};

function failure(error: string): PersistDocumentStateCaptureResult {
	return { ok: false, error };
}

function isCanonicalRecordPrototype(prototype: object | null): boolean {
	return prototype === null || prototype === Object.prototype;
}

function captureValue(
	input: unknown,
	path: string,
	context: CaptureContext,
): { ok: true; value: unknown } | { ok: false; error: string } {
	if (typeof input === 'string') return { ok: true, value: input };
	if (input === null || typeof input === 'boolean') return { ok: true, value: input };
	if (typeof input === 'number') {
		return Number.isFinite(input)
			? { ok: true, value: input }
			: failure(`${path} must contain only finite numbers.`);
	}
	if (typeof input !== 'object') return failure(`${path} contains a non-JSON value.`);
	if (context.active.has(input)) return failure(`${path} must not be cyclic.`);
	if (isRuntimeProxy(input)) return failure(`${path} must not be a proxy.`);

	context.active.add(input);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const prototype = Object.getPrototypeOf(input);
		if (Array.isArray(input)) {
			if (prototype !== Array.prototype || Reflect.get(descriptors, Symbol.iterator) !== undefined) {
				return failure(`${path} must use the canonical array prototype and iterator.`);
			}
			const lengthDescriptor = Reflect.get(descriptors, 'length') as PropertyDescriptor | undefined;
			const length = lengthDescriptor?.value;
			if (!Number.isSafeInteger(length) || Number(length) < 0) {
				return failure(`${path} has an invalid array length.`);
			}
			const keys = Reflect.ownKeys(descriptors);
			if (keys.length !== Number(length) + 1) {
				return failure(`${path} must be dense and contain no additional fields.`);
			}
			const allowedKeys = new Set<PropertyKey>(['length']);
			const captured: unknown[] = [];
			for (let index = 0; index < Number(length); index++) {
				const key = String(index);
				allowedKeys.add(key);
				const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
				if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
					return failure(`${path} must be dense and contain only data entries.`);
				}
				const item = captureValue(descriptor.value, `${path}[${index}]`, context);
				if (!item.ok) return item;
				captured.push(item.value);
			}
			for (const key of Reflect.ownKeys(descriptors)) {
				if (!allowedKeys.has(key)) return failure(`${path} contains an unsupported array field.`);
			}
			return { ok: true, value: captured };
		}

		if (!isCanonicalRecordPrototype(prototype)) {
			return failure(`${path} must use a canonical object prototype.`);
		}
		const keys = Reflect.ownKeys(descriptors);
		const captured = Object.create(null) as UnknownRecord;
		for (const key of keys) {
			if (typeof key !== 'string') return failure(`${path} contains a symbol field.`);
			const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
			if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${path}.${key} must be an own enumerable data property.`);
			}
			const value = captureValue(descriptor.value, `${path}.${key}`, context);
			if (!value.ok) return value;
			captured[key] = value.value;
		}
		return { ok: true, value: captured };
	} catch {
		return failure(`${path} could not be inspected.`);
	} finally {
		context.active.delete(input);
	}
}

export function capturePersistDocumentState(input: unknown): PersistDocumentStateCaptureResult {
	const captured = captureValue(
		input,
		'state',
		{ active: new Set() },
	);
	if (!captured.ok) return captured;
	if (!captured.value || typeof captured.value !== 'object' || Array.isArray(captured.value)) {
		return failure('Persisted state must be an object.');
	}
	const state = captured.value as UnknownRecord;
	if (!Array.isArray(state.sections)) return failure('Persisted state must contain a section array.');
	for (let index = 0; index < state.sections.length; index++) {
		const section = state.sections[index];
		if (!section || typeof section !== 'object' || Array.isArray(section)
			|| typeof (section as UnknownRecord).type !== 'string'
			|| !(section as UnknownRecord).type?.toString().trim()) {
			return failure(`Persisted section ${index} must be an object with a non-empty type.`);
		}
	}
	for (const preference of ['caretDocsEnabled', 'autoTriggerAutocompleteEnabled']) {
		if (state[preference] !== undefined && typeof state[preference] !== 'boolean') {
			return failure(`Persisted state ${preference} must be a boolean when present.`);
		}
	}
	return {
		ok: true,
		value: state as UnknownRecord & { sections: UnknownRecord[] },
	};
}

function canonicalNonblankString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nonnegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parsePersistDocumentMessage(input: unknown): PersistDocumentMessageParseResult {
	if (isRuntimeProxy(input)) return { ok: false, error: 'Native persistence message must not be a proxy.' };
	const existing = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	const envelope = existing
		? { ok: true as const, value: input as Record<string, unknown> & { type: string }, descriptorSnapshot: existing }
		: captureRuntimeMessageEnvelope(input);
	if (!envelope.ok || envelope.value.type !== 'persistDocument') {
		return { ok: false, error: 'Native persistence message type is invalid.' };
	}
	if (isRuntimeProxy(envelope.descriptorSnapshot.input)) {
		return { ok: false, error: 'Native persistence message must not be a proxy.' };
	}
	if (!isCanonicalRecordPrototype(envelope.descriptorSnapshot.prototype)) {
		return { ok: false, error: 'Native persistence message must use a canonical object prototype.' };
	}
	const message = envelope.value;
	const state = capturePersistDocumentState(message.state);
	if (!state.ok) return state;
	if (!nonnegativeSafeInteger(message.sourceGeneration)) {
		return { ok: false, error: 'Native persistence sourceGeneration must be a non-negative safe integer.' };
	}
	for (const key of ['flush', 'testOnlyNoop'] as const) {
		if (message[key] !== undefined && typeof message[key] !== 'boolean') {
			return { ok: false, error: `Native persistence ${key} must be a boolean when present.` };
		}
	}
	if (message.reason !== undefined && typeof message.reason !== 'string') {
		return { ok: false, error: 'Native persistence reason must be a string when present.' };
	}
	for (const key of ['snapshotId', 'flushRequestId', 'flushUnavailableReason'] as const) {
		if (message[key] !== undefined && !canonicalNonblankString(message[key])) {
			return { ok: false, error: `Native persistence ${key} must be a canonical non-empty string.` };
		}
	}
	const unavailable = message.flushUnavailableReason !== undefined;
	if (unavailable) {
		if (!canonicalNonblankString(message.flushRequestId)
			|| message.snapshotId !== undefined || message.editRevision !== undefined) {
			return { ok: false, error: 'Unavailable native persistence identity is invalid.' };
		}
	} else if (message.snapshotId !== undefined || message.editRevision !== undefined) {
		if (!canonicalNonblankString(message.snapshotId) || !nonnegativeSafeInteger(message.editRevision)) {
			return { ok: false, error: 'Native persistence snapshot identity is invalid.' };
		}
	} else if (!canonicalNonblankString(message.flushRequestId)) {
		return { ok: false, error: 'Native persistence requires snapshot or final-persist identity.' };
	}
	return {
		ok: true,
		value: { ...message, state: state.value } as PersistDocumentMessage,
	};
}