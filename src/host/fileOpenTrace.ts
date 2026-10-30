import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { getWorkbenchLogger, isWorkbenchTraceEnabled } from './workbenchLogger';
import { getWorkbenchTabInputUris, normalizeWorkbenchUriKey } from './workbenchFileTypes';

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

export function observeFileOpenActivation(trace: FileOpenTrace, uri: vscode.Uri, readState: () => {
	phase: 'lifecycle' | 'openWith' | 'recovery' | 'release';
	backgroundOwnerMember: boolean;
	backgroundOperationMember: boolean;
	mutationBlockCount: number;
}): { dispose(): void } {
	let dispose = () => {};
	try {
		if (!isWorkbenchTraceEnabled()) return { dispose };
		const key = normalizeWorkbenchUriKey(uri), uriHash = createHash('sha256').update(key).digest('hex');
		const listeners: vscode.Disposable[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, events = 0, suppressed = 0;
		const read = <Value>(getter: () => Value): Value | 'unavailable' => {
			try { return getter(); } catch { return 'unavailable'; }
		};
		const matchesTab = (tab: vscode.Tab) => getWorkbenchTabInputUris(tab.input).some(candidate => normalizeWorkbenchUriKey(candidate) === key);
		const mark = (event: string, eventDocument?: vscode.TextDocument, terminal = false) => {
			try {
				const state = read(() => {
					const value = readState();
					return { phase: value.phase, backgroundOwnerMember: value.backgroundOwnerMember,
						backgroundOperationMember: value.backgroundOperationMember, mutationBlockCount: value.mutationBlockCount };
				});
				const opened = read(() => vscode.workspace.textDocuments.find(document => normalizeWorkbenchUriKey(document.uri) === key));
				const document = eventDocument ?? (opened === 'unavailable' ? undefined : opened);
				const tabs = read(() => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(matchesTab));
				trace.mark(`observe.${event}`, {
					uriHash, ...(state === 'unavailable' ? { state } : state),
					document: opened === 'unavailable' ? 'unavailable' : { present: opened !== undefined,
						...(document ? { version: read(() => document.version), isDirty: read(() => document.isDirty), isClosed: read(() => document.isClosed) } : {}) },
					tabs: tabs === 'unavailable' ? 'unavailable' : { count: tabs.length,
						active: read(() => tabs.some(tab => tab.isActive)), custom: read(() => tabs.some(tab => tab.input instanceof vscode.TabInputCustom)) },
					...(terminal ? { suppressed } : {}),
				});
			} catch {}
		};
		const eventMark = (event: string, document?: vscode.TextDocument) => {
			if (stopped) return;
			if (events >= 29) { suppressed++; return; }
			events++;
			mark(event, document);
		};
		const documentEvent = (event: string, document: vscode.TextDocument) => {
			if (stopped) return;
			try { if (normalizeWorkbenchUriKey(document.uri) === key) eventMark(event, document); }
			catch { eventMark('unavailable'); }
		};
		dispose = () => {
			if (stopped) return;
			stopped = true;
			mark('stop', undefined, true);
			try { if (timer !== undefined) clearTimeout(timer); } catch {}
			for (const listener of listeners) { try { listener.dispose(); } catch {} }
		};
		try {
			mark('start');
			listeners.push(vscode.workspace.onDidOpenTextDocument(document => documentEvent('documentOpen', document)));
			listeners.push(vscode.workspace.onDidCloseTextDocument(document => documentEvent('documentClose', document)));
			listeners.push(vscode.window.tabGroups.onDidChangeTabs(event => {
				if (stopped) return;
				try { if ([...event.opened, ...event.closed, ...event.changed].some(matchesTab)) eventMark('tabsChanged'); }
				catch { eventMark('unavailable'); }
			}));
			timer = setTimeout(() => { if (!stopped) mark('pending'); }, 5000);
			timer.unref?.();
		} catch { eventMark('unavailable'); dispose(); }
	} catch {}
	return { dispose };
}
