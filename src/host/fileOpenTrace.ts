import { getWorkbenchLogger } from './workbenchLogger';

let nextFileOpenTraceId = 1;

export type FileOpenTrace = {
	readonly id: number;
	readonly label: string;
	mark(event: string, detail?: unknown): void;
};

function safeDetail(detail: unknown): string {
	if (detail === undefined) {
		return '';
	}
	try {
		return ` ${JSON.stringify(detail)}`;
	} catch {
		return ` ${String(detail)}`;
	}
}

export function createFileOpenTrace(label: string, detail?: unknown): FileOpenTrace {
	const id = nextFileOpenTraceId++;
	const startedAt = Date.now();
	const trace: FileOpenTrace = {
		id,
		label,
		mark(event: string, eventDetail?: unknown): void {
			const elapsedMs = Date.now() - startedAt;
			getWorkbenchLogger().trace(`[file-open:${id}] +${elapsedMs}ms ${label}.${event}${safeDetail(eventDetail)}`);
		},
	};
	trace.mark('start', detail);
	return trace;
}
