import { captureRuntimeMessageEnvelope, isRuntimeProxy } from './runtimeMessageEnvelope.js';

export const SCHEMA_DATA_BYTES_CODEC = 'schemaDataBytes/2';
const SERIALIZED_SCHEMA_DATA_TYPE = 'serializedSchemaData';
const schemaBytes = new WeakMap<object, { signature: string; bytes: Uint8Array }>();
const MAX_DECODED_SCHEMA_BYTES = 64 * 1024 * 1024;
let lastDecodedSchema: { bytes: Uint8Array; schema: object } | undefined;

function sameSchemaBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let offset = 0; offset < left.byteLength; offset++) {
		if (left[offset] !== right[offset]) return false;
	}
	return true;
}

function freezeDecodedSchema(schema: object): void {
	const pending = [schema];
	while (pending.length) {
		const current = pending.pop()!;
		Object.freeze(current);
		for (const value of Object.values(current)) {
			if (value && typeof value === 'object') pending.push(value);
		}
	}
}

function ownMessageType(message: unknown): unknown {
	if (!message || typeof message !== 'object' || isRuntimeProxy(message)) return undefined;
	return Object.getOwnPropertyDescriptor(message, 'type')?.value;
}

export function encodeMainWebviewHostMessage(message: unknown, schemaDataBytes: boolean): unknown {
	if (!schemaDataBytes || ownMessageType(message) !== 'schemaData') return message;
	const captured = captureRuntimeMessageEnvelope(message);
	if (!captured.ok) return undefined;
	const { schema, ...metadata } = captured.value;
	if (!schema || typeof schema !== 'object' || Array.isArray(schema) || isRuntimeProxy(schema)) return undefined;
	const schemaMeta = captured.value.schemaMeta;
	const signature = schemaMeta && typeof schemaMeta === 'object' && !isRuntimeProxy(schemaMeta)
		? Object.getOwnPropertyDescriptor(schemaMeta, 'schemaSignature')?.value
		: undefined;
	const cached = typeof signature === 'string' && signature.length > 0 ? schemaBytes.get(schema) : undefined;
	let bytes = cached && cached.signature === signature ? cached.bytes : undefined;
	if (!bytes) {
		bytes = new TextEncoder().encode(JSON.stringify(schema));
		if (typeof signature === 'string' && signature.length > 0) schemaBytes.set(schema, { signature, bytes });
	}
	return {
		type: SERIALIZED_SCHEMA_DATA_TYPE,
		metadata,
		payload: bytes,
	};
}

export function decodeMainWebviewHostMessage(message: unknown): unknown {
	try {
		if (ownMessageType(message) !== SERIALIZED_SCHEMA_DATA_TYPE) return message;
		const captured = captureRuntimeMessageEnvelope(message);
		if (!captured.ok || !ArrayBuffer.isView(captured.value.payload)) return undefined;
		if (isRuntimeProxy(captured.value.metadata)) return undefined;
		const metadata = captureRuntimeMessageEnvelope(captured.value.metadata);
		if (!metadata.ok || metadata.value.type !== 'schemaData'
			|| (metadata.descriptorSnapshot.prototype !== null && metadata.descriptorSnapshot.prototype !== Object.prototype)
			|| Object.prototype.hasOwnProperty.call(metadata.value, 'schema')) return undefined;
		const payload = captured.value.payload;
		const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
		const cacheable = bytes.buffer instanceof ArrayBuffer && bytes.byteLength <= MAX_DECODED_SCHEMA_BYTES;
		let schema: object;
		if (cacheable && lastDecodedSchema && sameSchemaBytes(bytes, lastDecodedSchema.bytes)) {
			schema = lastDecodedSchema.schema;
		} else {
			const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
			schema = parsed;
			if (cacheable) {
				freezeDecodedSchema(schema);
				lastDecodedSchema = { bytes: bytes.slice(), schema };
			}
		}
		Object.defineProperty(metadata.value, 'schema', { value: schema, enumerable: true, configurable: true, writable: true });
		return metadata.value;
	} catch {
		return undefined;
	}
}