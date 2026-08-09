import { isWorkbenchDocumentKind, type WorkbenchDocumentKind } from './documentSectionCapabilities.js';

export const BROWSER_VIEWER_PRESENTATION_READY_EVENT = 'kusto-workbench-browser-presentation-ready';
export const BROWSER_VIEWER_PROJECTION_EVENT = 'kusto-workbench-browser-projection';
export const BROWSER_VIEWER_PROJECTION_APPLIED_EVENT = 'kusto-workbench-browser-projection-applied';
export const BROWSER_VIEWER_PRESENTATION_READY_DATASET_KEY = 'kustoBrowserPresentationReady';

export type BrowserViewerCapabilities = Readonly<{
	readDocument: true;
	editDocument: false;
	persistDocument: false;
	authenticate: false;
	executeKusto: false;
	executeSql: false;
	useCopilot: false;
	downloadDerivedFile: true;
	activeContentPolicy: 'deferred';
}>;

export const BROWSER_VIEWER_READ_ONLY_CAPABILITIES: BrowserViewerCapabilities = Object.freeze({
	readDocument: true,
	editDocument: false,
	persistDocument: false,
	authenticate: false,
	executeKusto: false,
	executeSql: false,
	useCopilot: false,
	downloadDerivedFile: true,
	activeContentPolicy: 'deferred',
});

export type BrowserViewerState = Readonly<{
	sections: readonly unknown[];
	[key: string]: unknown;
}>;

export type BrowserViewerDocument = Readonly<{
	kind: WorkbenchDocumentKind;
	version: 1;
	state: BrowserViewerState;
	[key: string]: unknown;
}>;

export type BrowserViewerProjection = Readonly<{
	type: 'browser-viewer-projection';
	source: Readonly<{
		generation: number;
		filename: string;
		rawContentUrl: string;
		sidecarUrl?: string;
		pageUrl: string;
		sourceLabel: string;
	}>;
	capabilities: BrowserViewerCapabilities;
	document: BrowserViewerDocument;
	presentationState: BrowserViewerState;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasReadOnlyCapabilities(value: unknown): value is BrowserViewerCapabilities {
	if (!isRecord(value)) return false;
	return value.readDocument === true
		&& value.editDocument === false
		&& value.persistDocument === false
		&& value.authenticate === false
		&& value.executeKusto === false
		&& value.executeSql === false
		&& value.useCopilot === false
		&& value.downloadDerivedFile === true
		&& value.activeContentPolicy === 'deferred';
}

function hasSections(value: unknown): value is BrowserViewerState {
	return isRecord(value) && Array.isArray(value.sections);
}

export function isBrowserViewerProjection(value: unknown): value is BrowserViewerProjection {
	if (!isRecord(value) || value.type !== 'browser-viewer-projection') return false;
	if (!isRecord(value.source)
		|| !Number.isSafeInteger(value.source.generation)
		|| Number(value.source.generation) <= 0
		|| typeof value.source.filename !== 'string'
		|| typeof value.source.rawContentUrl !== 'string'
		|| typeof value.source.pageUrl !== 'string'
		|| typeof value.source.sourceLabel !== 'string'
		|| (value.source.sidecarUrl !== undefined && typeof value.source.sidecarUrl !== 'string')) return false;
	if (!hasReadOnlyCapabilities(value.capabilities)) return false;
	if (!isRecord(value.document)
		|| !isWorkbenchDocumentKind(value.document.kind)
		|| value.document.version !== 1
		|| !hasSections(value.document.state)) return false;
	return hasSections(value.presentationState);
}

export type BrowserViewerProjectionAppliedDetail = Readonly<{
	generation: number;
	applied: boolean;
}>;