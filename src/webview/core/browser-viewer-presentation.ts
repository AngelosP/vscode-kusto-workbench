import {
	BROWSER_VIEWER_PRESENTATION_READY_DATASET_KEY,
	BROWSER_VIEWER_PRESENTATION_READY_EVENT,
	BROWSER_VIEWER_PROJECTION_APPLIED_EVENT,
	BROWSER_VIEWER_PROJECTION_EVENT,
	isBrowserViewerProjection,
	type BrowserViewerProjectionAppliedDetail,
} from '../../shared/browserViewerProjection.js';
import { defaultSectionKindForDocument } from '../../shared/documentSectionCapabilities.js';
import { applyEditingPreferencesData } from './editing-preferences.js';
import {
	applyBrowserViewerDocumentProjection,
	applyKustoLeaveNoTracePolicy,
} from './persistence.js';
import { pState } from '../shared/persistence-state.js';
import {
	cachedDatabases,
	setConnections,
	setKustoFavorites,
	setLastConnectionId,
	setLastDatabase,
	setLeaveNoTraceClusters,
	setSqlConnections,
	setSqlFavorites,
	sqlCachedDatabases,
} from './state.js';

function clearRecord(record: Record<string, unknown>): void {
	for (const key of Object.keys(record)) delete record[key];
}

function resetUnavailableHostState(): void {
	setConnections([]);
	setLastConnectionId(null);
	setLastDatabase(null);
	clearRecord(cachedDatabases);
	setKustoFavorites([]);
	setLeaveNoTraceClusters([]);
	setSqlConnections([]);
	clearRecord(sqlCachedDatabases);
	setSqlFavorites([]);
	applyKustoLeaveNoTracePolicy([], false, undefined, {});
	applyEditingPreferencesData({
		type: 'editingPreferencesData',
		revision: 0,
		caretDocsEnabled: false,
		caretDocsEnabledUserSet: false,
		autoTriggerAutocompleteEnabled: false,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabled: false,
		copilotInlineCompletionsEnabledUserSet: false,
	});
}

export function applyBrowserViewerProjection(value: unknown): boolean {
	if ((window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode !== true
		|| !isBrowserViewerProjection(value)) return false;

	resetUnavailableHostState();
	document.body.dataset.kustoBrowserReadOnly = 'true';
	pState.isSessionFile = false;
	pState.documentUri = value.source.pageUrl || value.source.rawContentUrl;
	pState.firstSectionPinned = false;
	pState.documentMutationAllowed = false;
	pState.htmlPowerBiCompatibilityCheckEnabled = false;
	return applyBrowserViewerDocumentProjection({
		ok: true,
		state: value.presentationState,
		documentUri: pState.documentUri,
		documentKind: value.document.kind,
		allowedSectionKinds: [],
		defaultSectionKind: defaultSectionKindForDocument(value.document.kind),
		compatibilityMode: false,
		documentMutationAllowed: false,
		htmlPowerBiCompatibilityCheckEnabled: false,
		sourceGeneration: value.source.generation,
	});
}

function announceProjectionApplied(generation: number, applied: boolean): void {
	const detail: BrowserViewerProjectionAppliedDetail = Object.freeze({ generation, applied });
	window.dispatchEvent(new CustomEvent(BROWSER_VIEWER_PROJECTION_APPLIED_EVENT, { detail }));
}

function handleBrowserViewerProjection(event: Event): void {
	if (!(event instanceof CustomEvent) || !isBrowserViewerProjection(event.detail)) return;
	let applied = false;
	try {
		applied = applyBrowserViewerProjection(event.detail);
	} catch (error) {
		console.error('[browser-viewer]', error);
	}
	announceProjectionApplied(event.detail.source.generation, applied);
}

if ((window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode === true) {
	window.addEventListener(BROWSER_VIEWER_PROJECTION_EVENT, handleBrowserViewerProjection);
	document.documentElement.dataset[BROWSER_VIEWER_PRESENTATION_READY_DATASET_KEY] = 'true';
	window.dispatchEvent(new Event(BROWSER_VIEWER_PRESENTATION_READY_EVENT));
}