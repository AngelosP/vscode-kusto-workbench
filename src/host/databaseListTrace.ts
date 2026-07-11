import { createHash, randomUUID } from 'crypto';

import type { WorkbenchLogger } from './workbenchLogger';

export type DatabaseListErrorDetails = {
	errorType: string;
	status?: number;
	code?: string;
};

const SENSITIVE_IDENTIFIER_KEYS = /^(?:boxId|clusterEndpoint|clusterKey|clusterUrl|connectionId|database|modelUri|requestId|requestToken|schemaKey)$/i;
const SAFE_ERROR_CODE = /^(?:AADSTS\d+|E[A-Z0-9_]+|ERR_[A-Z0-9_]+|KUSTO[A-Z0-9_.-]*)$/i;

export function createDatabaseListTraceId(): string {
	return randomUUID();
}

export function databaseListTraceRef(value: unknown): string {
	const text = String(value ?? '').trim();
	if (!text) {
		return 'none';
	}
	return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function sanitizeTraceText(value: unknown, maxLength: number = 500): string {
	const text = String(value ?? '')
		.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
		.replace(/([?&](?:access_token|client_secret|code|key|password|sig|signature|token)=)[^&\s]+/gi, '$1[redacted]')
		.replace(/("(?:access_token|client_secret|code|key|password|sig|signature|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
		.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function readErrorChain(error: unknown): unknown[] {
	const pending: unknown[] = [error];
	const seen = new Set<unknown>();
	const chain: unknown[] = [];
	while (pending.length > 0 && chain.length < 12) {
		const candidate = pending.shift();
		if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function') || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		chain.push(candidate);
		for (const key of ['cause', 'innerError', 'error', 'originalError', 'response']) {
			try {
				const nested = (candidate as Record<string, unknown>)[key];
				if (nested) {
					pending.push(nested);
				}
			} catch {
				// Ignore malformed SDK error properties.
			}
		}
	}
	return chain;
}

function safeErrorType(value: unknown): string {
	const name = String(value ?? '').trim();
	if (/^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|AbortError|RestError|Kusto[A-Za-z0-9]*Error|QueryCancelledError|QueryExecutionError)$/.test(name)) {
		return name;
	}
	return 'Error';
}

export function getDatabaseListErrorDetails(error: unknown): DatabaseListErrorDetails {
	try {
		const chain = readErrorChain(error);
		const first = chain[0] as Record<string, unknown> | undefined;
		let firstName: unknown;
		try {
			firstName = first?.name;
		} catch {
			firstName = undefined;
		}
		const details: DatabaseListErrorDetails = {
			errorType: safeErrorType(firstName ?? (error instanceof Error ? error.name : undefined)),
		};

		for (const candidate of chain) {
			try {
				const record = candidate as Record<string, unknown>;
				const status = record.statusCode ?? record.status;
				if (typeof status === 'number' && Number.isFinite(status)) {
					details.status = status;
					break;
				}
				if (typeof status === 'string' && /^\d{3}$/.test(status)) {
					details.status = Number(status);
					break;
				}
			} catch {
				// Continue through the bounded error graph.
			}
		}

		for (const candidate of chain) {
			try {
				const rawCode = (candidate as Record<string, unknown>).code;
				const code = typeof rawCode === 'string' ? rawCode.trim() : '';
				if (SAFE_ERROR_CODE.test(code)) {
					details.code = code.slice(0, 80);
					break;
				}
			} catch {
				// Continue through the bounded error graph.
			}
		}
		return details;
	} catch {
		return { errorType: 'Error' };
	}
}

function formatTraceDetail(key: string, value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (SENSITIVE_IDENTIFIER_KEYS.test(key)) {
		return `${key}Ref=${databaseListTraceRef(value)}`;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? `${key}=${value}` : undefined;
	}
	if (typeof value === 'boolean') {
		return `${key}=${value}`;
	}
	return `${key}=${sanitizeTraceText(value)}`;
}

export function traceDatabaseList(
	output: WorkbenchLogger,
	traceId: string | undefined,
	scope: string,
	event: string,
	details: Record<string, unknown> = {}
): void {
	if (!traceId) {
		return;
	}
	try {
		const detailText = Object.entries(details)
			.map(([key, value]) => formatTraceDetail(key, value))
			.filter((value): value is string => !!value)
			.join(' ');
		const eventName = scope ? `${scope}.${event}` : event;
		output.trace(`[database-list:${traceId}] ${eventName}${detailText ? ` ${detailText}` : ''}`);
	} catch {
		// Diagnostics must never alter connection behavior.
	}
}
