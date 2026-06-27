export type WebviewPerfSnapshot = {
	durationMs: number;
	marks: Array<{ name: string; timeMs: number; detail?: unknown }>;
	measures: Record<string, number>;
};

type KustoWebviewPerf = {
	startTime: number;
	marks: Array<{ name: string; timeMs: number; detail?: unknown }>;
	mark: (name: string, detail?: unknown) => void;
	snapshot: () => WebviewPerfSnapshot;
};

const _win = window as any;

function safeDetail(detail: unknown): unknown {
	if (detail === undefined) return undefined;
	try { return JSON.parse(JSON.stringify(detail)); } catch { return String(detail); }
}

function createSnapshot(perf: KustoWebviewPerf): WebviewPerfSnapshot {
	const marks = Array.isArray(perf.marks) ? perf.marks.slice() : [];
	const byName = new Map<string, number>();
	for (const mark of marks) {
		if (!byName.has(mark.name)) {
			byName.set(mark.name, mark.timeMs);
		}
	}
	const delta = (from: string, to: string): number | undefined => {
		const a = byName.get(from);
		const b = byName.get(to);
		return typeof a === 'number' && typeof b === 'number' ? Math.max(0, b - a) : undefined;
	};
	const measures: Record<string, number> = {};
	const addMeasure = (name: string, value: number | undefined): void => {
		if (typeof value === 'number' && Number.isFinite(value)) measures[name] = value;
	};
	const requestDocumentSentMs = byName.get('webview.bootstrap.requestDocument.sent') ?? byName.get('webview.main.requestDocument.sent');
	addMeasure('htmlToRequestDocumentMs', requestDocumentSentMs);
	if (typeof requestDocumentSentMs === 'number') {
		const documentDataReceivedMs = byName.get('webview.message.documentData.received');
		addMeasure('requestToDocumentDataMs', typeof documentDataReceivedMs === 'number'
			? Math.max(0, documentDataReceivedMs - requestDocumentSentMs)
			: undefined);
	}
	addMeasure('documentDataToRestoreEndMs', delta('webview.message.documentData.received', 'webview.persistence.restore.end'));
	addMeasure('documentDataToFirstQuerySectionMs', delta('webview.message.documentData.received', 'webview.section.query.added'));
	addMeasure('documentDataToFirstQueryEditorReadyMs', delta('webview.message.documentData.received', 'webview.monaco.queryEditor.ready'));
	addMeasure('restoreStartToEndMs', delta('webview.persistence.restore.start', 'webview.persistence.restore.end'));
	return {
		durationMs: Math.max(0, performance.now() - perf.startTime),
		marks,
		measures,
	};
}

function ensurePerf(): KustoWebviewPerf {
	if (_win.__kustoPerf && typeof _win.__kustoPerf.mark === 'function' && Array.isArray(_win.__kustoPerf.marks)) {
		const existing = _win.__kustoPerf as KustoWebviewPerf;
		existing.startTime = typeof existing.startTime === 'number' ? existing.startTime : performance.now();
		existing.snapshot = function snapshot(): WebviewPerfSnapshot {
			return createSnapshot(this);
		};
		return existing;
	}
	const startTime = performance.now();
	const perf: KustoWebviewPerf = {
		startTime,
		marks: [],
		mark(name: string, detail?: unknown): void {
			this.marks.push({
				name: String(name || ''),
				timeMs: Math.max(0, performance.now() - this.startTime),
				...(detail === undefined ? {} : { detail: safeDetail(detail) }),
			});
		},
		snapshot(): WebviewPerfSnapshot {
			return createSnapshot(this);
		},
	};
	_win.__kustoPerf = perf;
	return perf;
}

export function perfMark(name: string, detail?: unknown): void {
	try { ensurePerf().mark(name, detail); } catch (e) { console.error('[kusto]', e); }
}

export function perfSnapshot(): WebviewPerfSnapshot {
	return ensurePerf().snapshot();
}

perfMark('webview.bundle.perfModule.loaded');