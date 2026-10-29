import { getWorkbenchLogger } from './workbenchLogger';

let nextFileOpenTraceId = 1;

export type FileOpenTrace = {
	readonly id: number;
	readonly label: string;
	mark(event: string, detail?: unknown): void;
};

export function createFileOpenTrace(label: string, detail?: unknown): FileOpenTrace {
	const id = nextFileOpenTraceId++;
	let startedAt: number | undefined;
	try { startedAt = Date.now(); } catch {}
	const trace: FileOpenTrace = {
		id,
		label,
		mark(event: string, eventDetail?: unknown): void {
			try {
				if (startedAt === undefined) return;
				const elapsedMs = Date.now() - startedAt;
				getWorkbenchLogger().trace(`[file-open:${id}] +${elapsedMs}ms ${label}.${event}${eventDetail === undefined ? '' : ` ${JSON.stringify(eventDetail)}`}`);
			} catch {}
		},
	};
	trace.mark('start', detail);
	return trace;
}
