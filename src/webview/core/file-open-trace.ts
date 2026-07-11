import { postMessageToHost } from '../shared/webview-messages';

const startedAt = performance.now();
let sequence = 0;

const IDENTIFIER_KEYS = /^(?:boxId|clusterName|clusterUrl|connectionId|database|modelKey|modelUri|requestId|requestToken|schemaKey)$/i;
const REDACTED_KEYS = /^(?:aliases|authorization|error|fullText|query|queryText|rawSchemaJson|schemaObj|secret|token|value)$/i;
const SAFE_STRING_KEYS = /^(?:action|deliverySource|errorType|failureKind|kind|previousStatus|reason|requestSource|source|stage|status)$/i;

function opaqueTraceId(value: unknown): string {
	const text = String(value ?? '');
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function safeDetail(detail: unknown, keyName: string = ''): unknown {
	if (detail === undefined) {
		return undefined;
	}
	if (detail === null || typeof detail === 'number' || typeof detail === 'boolean') return detail;
	if (typeof detail === 'string') {
		if (IDENTIFIER_KEYS.test(keyName)) return opaqueTraceId(detail);
		return SAFE_STRING_KEYS.test(keyName) ? detail.slice(0, 120) : opaqueTraceId(detail);
	}
	if (Array.isArray(detail)) return { count: detail.length };
	if (typeof detail === 'object') {
		const safe: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
			if (REDACTED_KEYS.test(key)) continue;
			if (IDENTIFIER_KEYS.test(key)) {
				safe[`${key}Id`] = opaqueTraceId(value);
				continue;
			}
			if (Array.isArray(value)) {
				safe[`${key}Count`] = value.length;
				continue;
			}
			safe[key] = safeDetail(value, key);
		}
		return safe;
	}
	return undefined;
}

export function traceFileOpen(event: string, detail?: unknown): void {
	try {
		postMessageToHost({
			type: 'fileOpenTrace',
			event,
			timeMs: Math.round((performance.now() - startedAt) * 10) / 10,
			sequence: ++sequence,
			...(detail === undefined ? {} : { detail: safeDetail(detail) }),
		});
	} catch {
		// Tracing must never affect webview behavior.
	}
}
