import { performance } from 'perf_hooks';

type PerfMark = {
	name: string;
	timeMs: number;
	detail?: unknown;
};

type PerfTrace = {
	id: number;
	label: string;
	startedAt: string;
	startTime: number;
	metadata?: unknown;
	marks: PerfMark[];
};

type PerfSnapshotTrace = Omit<PerfTrace, 'startTime'> & {
	durationMs: number;
};

type KustoPerfGlobal = {
	snapshot: () => unknown;
	reset: () => void;
};

const enabled = process.env.KUSTO_WORKBENCH_PERF === '1';
let nextTraceId = 1;
let currentTrace: PerfTrace | undefined;
let traces: PerfTrace[] = [];

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

function serializeTrace(trace: PerfTrace): PerfSnapshotTrace {
	return {
		id: trace.id,
		label: trace.label,
		startedAt: trace.startedAt,
		metadata: trace.metadata,
		marks: trace.marks.slice(),
		durationMs: Math.max(0, performance.now() - trace.startTime),
	};
}

function snapshot(): unknown {
	return {
		enabled,
		current: currentTrace ? serializeTrace(currentTrace) : null,
		traces: traces.map(serializeTrace),
	};
}

function reset(): void {
	currentTrace = undefined;
	traces = [];
	nextTraceId = 1;
}

function installGlobal(): void {
	try {
		(globalThis as unknown as { __kustoPerf?: KustoPerfGlobal }).__kustoPerf = { snapshot, reset };
	} catch {
		// ignore
	}
}

installGlobal();

export function perfBegin(label: string, metadata?: unknown): void {
	if (!enabled) {
		return;
	}
	currentTrace = {
		id: nextTraceId++,
		label,
		startedAt: new Date().toISOString(),
		startTime: performance.now(),
		metadata: safeDetail(metadata),
		marks: [],
	};
	traces.push(currentTrace);
	if (traces.length > 20) {
		traces = traces.slice(-20);
	}
	perfMark(`${label}.start`);
}

export function perfMark(name: string, detail?: unknown): void {
	if (!enabled || !currentTrace) {
		return;
	}
	currentTrace.marks.push({
		name,
		timeMs: Math.max(0, performance.now() - currentTrace.startTime),
		...(detail === undefined ? {} : { detail: safeDetail(detail) }),
	});
}