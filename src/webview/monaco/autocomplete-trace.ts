export type AutocompleteTraceStatus = 'active' | 'success' | 'failed' | 'abandoned';

export interface AutocompleteTraceEvent {
	at: number;
	perf: number;
	event: string;
	detail?: unknown;
}

export interface AutocompleteTraceSession {
	id: string;
	startedAt: number;
	finishedAt?: number;
	status: AutocompleteTraceStatus;
	seed?: unknown;
	events: AutocompleteTraceEvent[];
}

const MAX_SESSIONS = 30;
const MAX_EVENTS_PER_SESSION = 160;
const MAX_STRING_LENGTH = 800;
const MAX_ARRAY_LENGTH = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 5;
const REDACTED_KEYS = new Set([
	'rawschemajson',
	'schemaobj',
	'query',
	'querytext',
	'fulltext',
	'textbefore',
	'textafter',
	'value',
	'valuepreview',
	'currentline',
	'linenearcursor',
	'wordnearcursor',
	'widgetcontent',
	'token',
	'accesstoken',
	'idtoken',
	'password',
	'secret',
	'authorization',
	'connectionstring',
	'apikey',
	'sas',
]);

const sessions: AutocompleteTraceSession[] = [];
const sessionById = new Map<string, AutocompleteTraceSession>();
let sequence = 0;
let lastTraceId = '';

function nowPerf(): number {
	try {
		return typeof performance !== 'undefined' && typeof performance.now === 'function'
			? Math.round(performance.now())
			: 0;
	} catch {
		return 0;
	}
}

function truncateString(value: string): string {
	const text = String(value || '');
	return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH - 3)}...` : text;
}

function sanitizeDetail(value: unknown, depth = 0, keyName = ''): unknown {
	if (value === null || value === undefined) return value;
	const key = String(keyName || '').toLowerCase();
	if (REDACTED_KEYS.has(key)) return '[redacted]';
	if (typeof value === 'string') return truncateString(value.replace(/[\r\t]+/g, ' '));
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'bigint') return String(value);
	if (typeof value === 'function') return '[function]';
	if (depth >= MAX_DEPTH) return '[max-depth]';
	if (Array.isArray(value)) {
		const out = value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitizeDetail(item, depth + 1, keyName));
		if (value.length > MAX_ARRAY_LENGTH) out.push(`[+${value.length - MAX_ARRAY_LENGTH} more]`);
		return out;
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
		for (const [key, child] of entries) {
			out[key] = sanitizeDetail(child, depth + 1, key);
		}
		const totalKeys = Object.keys(value as Record<string, unknown>).length;
		if (totalKeys > MAX_OBJECT_KEYS) {
			out.__truncatedKeys = totalKeys - MAX_OBJECT_KEYS;
		}
		return out;
	}
	return String(value);
}

function cloneSession(session: AutocompleteTraceSession): AutocompleteTraceSession {
	return {
		id: session.id,
		startedAt: session.startedAt,
		finishedAt: session.finishedAt,
		status: session.status,
		seed: sanitizeDetail(session.seed),
		events: session.events.map(event => ({
			at: event.at,
			perf: event.perf,
			event: event.event,
			detail: sanitizeDetail(event.detail),
		})),
	};
}

function rememberSession(session: AutocompleteTraceSession): void {
	sessions.push(session);
	sessionById.set(session.id, session);
	while (sessions.length > MAX_SESSIONS) {
		const removed = sessions.shift();
		if (removed) sessionById.delete(removed.id);
	}
}

export function startAutocompleteTrace(seed?: unknown): string {
	const id = `ac_${Date.now()}_${++sequence}`;
	const session: AutocompleteTraceSession = {
		id,
		startedAt: Date.now(),
		status: 'active',
		seed: sanitizeDetail(seed),
		events: [],
	};
	lastTraceId = id;
	rememberSession(session);
	recordAutocompleteTrace(id, 'trace-start', seed);
	return id;
}

export function recordAutocompleteTrace(traceId: string | undefined, event: string, detail?: unknown): void {
	if (!traceId) return;
	const session = sessionById.get(traceId);
	if (!session) return;
	session.events.push({
		at: Date.now(),
		perf: nowPerf(),
		event: String(event || 'event'),
		detail: sanitizeDetail(detail),
	});
	if (session.events.length > MAX_EVENTS_PER_SESSION) {
		session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION + 1);
		session.events.unshift({ at: Date.now(), perf: nowPerf(), event: 'trace-events-truncated' });
	}
}

export function finishAutocompleteTrace(traceId: string | undefined, status: AutocompleteTraceStatus, detail?: unknown): void {
	if (!traceId) return;
	const session = sessionById.get(traceId);
	if (!session) return;
	recordAutocompleteTrace(traceId, 'trace-finish', { status, ...(detail && typeof detail === 'object' ? detail as Record<string, unknown> : { detail }) });
	session.status = status;
	session.finishedAt = Date.now();
}

export function getAutocompleteTrace(traceId?: string): AutocompleteTraceSession | AutocompleteTraceSession[] | null {
	if (traceId) {
		const session = sessionById.get(traceId);
		return session ? cloneSession(session) : null;
	}
	return sessions.map(cloneSession);
}

export function getLastAutocompleteTraceId(): string {
	return lastTraceId;
}

export function getActiveAutocompleteTraceId(): string {
	const session = lastTraceId ? sessionById.get(lastTraceId) : null;
	return session && session.status === 'active' && !session.finishedAt ? lastTraceId : '';
}

export function clearAutocompleteTrace(): void {
	sessions.length = 0;
	sessionById.clear();
	lastTraceId = '';
}

export function compactAutocompleteTrace(traceId?: string): unknown {
	const trace = traceId ? getAutocompleteTrace(traceId) : getAutocompleteTrace(lastTraceId);
	if (!trace || Array.isArray(trace)) return trace;
	return {
		id: trace.id,
		status: trace.status,
		startedAt: trace.startedAt,
		finishedAt: trace.finishedAt,
		seed: trace.seed,
		events: trace.events.map(event => ({ event: event.event, detail: event.detail })),
	};
}
