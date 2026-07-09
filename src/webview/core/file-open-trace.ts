import { postMessageToHost } from '../shared/webview-messages';

const startedAt = performance.now();
let sequence = 0;

function safeDetail(detail: unknown): unknown {
	if (detail === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(JSON.stringify(detail));
	} catch {
		return String(detail);
	}
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
