// Section factory — merged from modules/queryBoxes.ts + modules/extraBoxes.ts
// Creates all section types: Query, Chart, Markdown, Transformation, Python, URL.
// Window bridge exports at bottom for remaining legacy callers.

// NOTE: circular with monaco/monaco.ts and monaco/resize.ts — all usages are lazy
// (inside function bodies only, never at module evaluation time).

import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from './persistence';
import {
	cachedDatabases,
	connections,
	favoritesModeByBoxId,
	pendingFavoriteSelectionByBoxId,
	queryEditors,
	queryEditorResizeObservers,
	queryEditorVisibilityObservers,
	queryEditorVisibilityMutationObservers,
	schemaByBoxId,
	schemaFetchInFlightByBoxId,
	lastSchemaRequestAtByBoxId,
	schemaByConnDb,
	schemaRequestResolversByBoxId,
	databasesRequestResolversByBoxId,
	missingClusterDetectTimersByBoxId,
	lastQueryTextByBoxId,
	missingClusterUrlsByBoxId,
	optimizationMetadataByBoxId,
	suggestedDatabaseByClusterKeyByBoxId,
	runModesByBoxId,
	queryBoxes,
	setQueryBoxes,
	kustoFavorites,
	caretDocsEnabled,
	autoTriggerAutocompleteEnabled,
	copilotInlineCompletionsEnabled,
	lastConnectionId,
	lastDatabase,
	setActiveMonacoEditor,
} from './state';
import { __kustoUpdateQueryResultsToggleButton, __kustoUpdateComparisonSummaryToggleButton, __kustoApplyResultsVisibility, __kustoApplyComparisonSummaryVisibility, setQueryExecuting, __kustoSetLinkedOptimizationMode } from '../sections/query-execution.controller';
import { indexToAlphaName as __kustoIndexToAlphaName } from '../shared/comparisonUtils';
import { buildSchemaInfo } from '../shared/schema-utils';
import { escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from './utils';

import { currentResult, resetCurrentResult, getResultsState, getRawCellValue as _getRawCellValueFromState } from './results-state';
import {
	formatClusterDisplayName,
	normalizeClusterUrlKey,
	formatClusterShortName,
	clusterShortNameKey,
	extractClusterUrlsFromQueryText,
	extractClusterDatabaseHintsFromQueryText,
	computeMissingClusterUrls as _computeMissing,
	favoriteKey as __kustoFavoriteKey,
	findFavorite as __kustoFindFavorite_pure,
	getFavoritesSorted as __kustoGetFavoritesSorted_pure,
	parseKustoConnectionString,
	findConnectionIdForClusterUrl as _findConnIdPure,
} from '../shared/clusterUtils';
import {
	getRawCellValue as _getRawCellValue,
	cellToChartString as _cellToChartString,
	cellToChartNumber as _cellToChartNumber,
	cellToChartTimeMs as _cellToChartTimeMs,
	inferTimeXAxisFromRows as _inferTimeXAxisFromRows,
	normalizeResultsColumnName as _normalizeResultsColumnName,
	pickFirstNonEmpty as _pickFirstNonEmpty,
} from '../shared/data-utils.js';
import { closeAllMenus as _closeAllDropdownMenus } from './dropdown';

import { renderChart as __kustoRenderChart, getChartState as __kustoGetChartState } from '../shared/chart-renderer';
import { normalizeLegendSortMode } from '../shared/chart-utils';
import { __kustoForceEditorWritable, __kustoInstallWritableGuard, __kustoEnsureEditorWritableSoon } from '../monaco/writable';
import { __kustoAttachAutoResizeToContent } from '../monaco/resize';
import { tryParseFiniteNumber, tryParseDate } from '../shared/transform-expr';
import { __kustoMonacoInitRetryCountByBoxId } from '../monaco/monaco';

const _win = window;

// ══════════════════════════════════════════════════════════════════════════════
// Query section creation (from queryBoxes.ts)
// ══════════════════════════════════════════════════════════════════════════════

export const schemaRequestTokenByBoxId: Record<string, string> = {};

// Diagnostics logging — no-op (was removed from original source, callers remain).
export function __kustoLog(_boxId?: any, _event?: any, _message?: any, _data?: any, _level?: any) { return; }

function __kustoGetUsedSectionNamesUpper( excludeBoxId: any) {
	const used = new Set();
	try {
		const container = document.getElementById('queries-container');
		if (container) {
			const children = Array.from(container.children || []);
			for (const child of children as any[]) {
				try {
					if (!child || !child.id) continue;
					if (excludeBoxId && child.id === excludeBoxId) continue;
					// Try Lit element first.
					if (typeof child.getName === 'function') {
						const v = String(child.getName() || '').trim();
						if (v) used.add(v.toUpperCase());
						continue;
					}
					// Legacy fallback: look for input.query-name inside.
					const input = child.querySelector ? child.querySelector('input.query-name') : null;
					if (input) {
						const v = String(input.value || '').trim();
						if (v) used.add(v.toUpperCase());
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return used;
}

export function pickNextAvailableAlphaName(used: Set<string>): string {
	for (let i = 0; i < 5000; i++) {
		const candidate = __kustoIndexToAlphaName(i).toUpperCase();
		if (!used.has(candidate)) {
			return candidate;
		}
	}
	return 'A';
}

export function __kustoPickNextAvailableSectionLetterName( excludeBoxId: any) {
	try {
		const used = __kustoGetUsedSectionNamesUpper(excludeBoxId);
		return pickNextAvailableAlphaName(used);
	} catch (e) { console.error('[kusto]', e); }
	return 'A';
}

function __kustoEnsureSectionHasDefaultNameIfMissing( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return '';
		const current = __kustoGetSectionName(id);
		if (current) return current;
		const next = __kustoPickNextAvailableSectionLetterName(id);
		__kustoSetSectionName(id, next);
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		return next;
	} catch {
		return '';
	}
}

// Expose for persistence + extra box types.
try {
	window.__kustoPickNextAvailableSectionLetterName = __kustoPickNextAvailableSectionLetterName;
} catch (e) { console.error('[kusto]', e); }

// ── Global accessor helpers for query section connection/database ──────────
// These functions abstract access to the connection/database state,
// working with both the Lit <kw-query-section> element's public API.
// Use these instead of document.getElementById(boxId + '_connection').
export function __kustoGetConnectionId( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getConnectionId === 'function') return el.getConnectionId();
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetDatabase( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getDatabase === 'function') return el.getDatabase();
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetClusterUrl( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getClusterUrl === 'function') return el.getClusterUrl();
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetQuerySectionElement( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getConnectionId === 'function') return el;
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

// Expose globally for other modules (main.js, monaco.js).
try {
	window.__kustoGetConnectionId = __kustoGetConnectionId;
	window.__kustoGetDatabase = __kustoGetDatabase;
	window.__kustoGetQuerySectionElement = __kustoGetQuerySectionElement;
} catch (e) { console.error('[kusto]', e); }

export function __kustoGetSectionName( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getName === 'function') return el.getName();
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoSetSectionName( boxId: any, name: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.setName === 'function') { el.setName(String(name || '')); return; }
	} catch (e) { console.error('[kusto]', e); }
}

try {
	window.__kustoSetSectionName = __kustoSetSectionName;
} catch (e) { console.error('[kusto]', e); }

// Clamp the query results output wrapper height so it cannot be taller than its contents.
// This avoids blank slack below short error messages while still allowing the user to
// resize smaller than contents (scrolling).
export function __kustoClampResultsWrapperHeight(boxId: any) {
	try {
		const bid = String(boxId || '').trim();
		if (!bid) return;
		const w = document.getElementById(bid + '_results_wrapper') as any;
		const resultsEl = document.getElementById(bid + '_results') as any;
		if (!w || !resultsEl) return;
		// If we have a table container (legacy or kw-data-table), results are intentionally scrollable; don't clamp.
		if (resultsEl.querySelector && (resultsEl.querySelector('.table-container') || resultsEl.querySelector('kw-data-table'))) return;

		const wrapperH = Math.max(0, Math.ceil(w.getBoundingClientRect().height || 0));
		const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
		const overheadPx = Math.max(0, wrapperH - resultsClientH);

		let contentPx = 0;
		const children = resultsEl.children ? Array.from(resultsEl.children) : [];
		if (children.length) {
			for (const child of children as any[]) {
				try {
					const rectH = Math.max(0, Math.ceil(child.getBoundingClientRect().height || 0));
					let margin = 0;
					try {
						const cs = getComputedStyle(child);
						margin += parseFloat(cs.marginTop || '0') || 0;
						margin += parseFloat(cs.marginBottom || '0') || 0;
					} catch (e) { console.error('[kusto]', e); }
					contentPx += rectH + Math.ceil(margin);
				} catch (e) { console.error('[kusto]', e); }
			}
		} else {
			const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
			contentPx = headerEl ? Math.max(0, Math.ceil(headerEl.getBoundingClientRect().height || 0)) : 0;
		}

		const desiredPx = Math.max(0, Math.ceil(overheadPx + contentPx + 8));

		if (wrapperH > (desiredPx + 1)) {
			w.style.height = desiredPx + 'px';
			w.style.minHeight = '0';
			try {
				if (w.dataset && w.dataset.kustoUserResized === 'true') {
					w.dataset.kustoPrevHeight = w.style.height;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function addQueryBox( options: any) {
	const isFirstBox = !(Array.isArray(queryBoxes) && queryBoxes.length > 0);
	const id = (options && options.id) ? String(options.id) : ('query_' + Date.now());
	const initialQuery = (options && options.initialQuery) ? String(options.initialQuery) : '';
	const isComparison = !!(options && options.isComparison);
	const defaultResultsVisible = (options && typeof options.defaultResultsVisible === 'boolean') ? !!options.defaultResultsVisible : true;
	const defaultComparisonSummaryVisible = isComparison ? true : ((options && typeof options.defaultComparisonSummaryVisible === 'boolean') ? !!options.defaultComparisonSummaryVisible : true);
	const defaultExpanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	const afterBoxId = (options && options.afterBoxId) ? String(options.afterBoxId) : '';

	// Insert into queryBoxes array at the right position.
	if (afterBoxId) {
		const afterIdx = queryBoxes.indexOf(afterBoxId);
		if (afterIdx >= 0) {
			queryBoxes.splice(afterIdx + 1, 0, id);
		} else {
			queryBoxes.push(id);
		}
	} else {
		queryBoxes.push(id);
	}

	const container = document.getElementById('queries-container');

	// ── The light DOM body (toolbar, editor, actions, results) is now created
	// by the <kw-query-section> Lit component in its connectedCallback.
	// This function just creates the host element with attributes.
	const boxHtml =
		'<kw-query-section class="query-box' + (isComparison ? ' is-optimized-comparison' : '') + '" id="' + id + '" box-id="' + id + '"' +
		(isComparison ? ' is-comparison' : '') +
		'></kw-query-section>';

	// Insert into the DOM — after a specific section or at the end.
	const afterEl = afterBoxId ? document.getElementById(afterBoxId) : null;
	if (afterEl) {
		afterEl.insertAdjacentHTML('afterend', boxHtml);
	} else {
		container.insertAdjacentHTML('beforeend', boxHtml);
	}
	// Do not auto-assign a name; section names are user-defined unless explicitly set by a feature.
	// Initialize toolbar toggle states from globals.
	try {
		const toolbar = document.querySelector('kw-query-toolbar[box-id="' + id + '"]') as any;
		if (toolbar) {
			if (typeof toolbar.setCaretDocsActive === 'function') toolbar.setCaretDocsActive(!!caretDocsEnabled);
			if (typeof toolbar.setAutoCompleteActive === 'function') toolbar.setAutoCompleteActive(!!autoTriggerAutocompleteEnabled);
			if (typeof toolbar.setCopilotInlineActive === 'function') toolbar.setCopilotInlineActive(!!copilotInlineCompletionsEnabled);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { if (typeof window.setRunMode === 'function') window.setRunMode(id, 'take100'); } catch (e) { console.error('[kusto]', e); }

	// ── Wire up <kw-query-section> event listeners ──
	const kwEl = document.getElementById(id) as any;
	if (kwEl) {
		kwEl.addEventListener('connection-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			// Clear schema so it doesn't mismatch.
			try { delete schemaByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			try { if (schemaFetchInFlightByBoxId) schemaFetchInFlightByBoxId[boxId] = false; } catch (e) { console.error('[kusto]', e); }
			try { if (lastSchemaRequestAtByBoxId) lastSchemaRequestAtByBoxId[boxId] = 0; } catch (e) { console.error('[kusto]', e); }
			try { delete schemaRequestTokenByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			// Persist selection.
			try {
				if (!pState.restoreInProgress) {
					postMessageToHost({
						type: 'saveLastSelection',
						connectionId: String(detail.connectionId || ''),
						database: ''
					});
				}
			} catch (e) { console.error('[kusto]', e); }
			// Load database list.
			if (detail.connectionId) {
				try {
					const cid = String(detail.connectionId || '').trim();
					const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
					const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
					let clusterKey = '';
					if (clusterUrl) {
						let u = clusterUrl;
						if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
						try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
					}
					const cached = (cachedDatabases && cachedDatabases[clusterKey]) || cachedDatabases[detail.connectionId];
					if (cached && cached.length > 0) {
						if (typeof kwEl.setDatabases === 'function') kwEl.setDatabases(cached);
						// Background refresh
						postMessageToHost({ type: 'getDatabases', connectionId: detail.connectionId, boxId: boxId });
						try { if (typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(true); } catch (e) { console.error('[kusto]', e); }
					} else {
						if (typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(true);
						postMessageToHost({ type: 'getDatabases', connectionId: detail.connectionId, boxId: boxId });
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			try { __kustoUpdateFavoritesUiForBox(boxId); } catch (e) { console.error('[kusto]', e); }
			try { if (typeof window.__kustoUpdateRunEnabledForBox === 'function') window.__kustoUpdateRunEnabledForBox(boxId); } catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('database-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { onDatabaseChanged(boxId); } catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('refresh-databases', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { refreshDatabases(boxId); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('favorite-toggle', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { toggleFavoriteForBox(boxId); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('favorites-mode-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try {
				if (typeof favoritesModeByBoxId === 'object') {
					favoritesModeByBoxId[boxId] = !!detail.favoritesMode;
				}
			} catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('favorite-selected', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			// connection-changed already fires before this event and handles getDatabases + schema clearing.
			// This handler only needs to persist and update UI state.
			try { if (typeof window.__kustoUpdateRunEnabledForBox === 'function') window.__kustoUpdateRunEnabledForBox(boxId); } catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('favorite-removed', (e: any) => {
			const detail = e.detail || {};
			try { removeFavorite(detail.clusterUrl, detail.database); } catch (e) { console.error('[kusto]', e); }
		});
		kwEl.addEventListener('schema-refresh', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { refreshSchema(boxId); } catch (e) { console.error('[kusto]', e); }
		});
	}

	// Default the connection to the query box above this one (if any).
	// This provides a better UX when adding multiple queries against the same cluster/database.
	try {
		if (!options || (!options.clusterUrl && !options.database)) {
			// Find the previous query box in the DOM (by iterating container children).
			const children = container ? Array.from(container.children || []) as any[] : [];
			let prevQueryBoxId = null;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				const childId = child && child.id ? String(child.id) : '';
				if (childId === id) continue;
				if (childId.startsWith('query_')) {
					prevQueryBoxId = childId;
					break;
				}
			}
			if (prevQueryBoxId) {
				const prevEl = document.getElementById(prevQueryBoxId) as any;
				const prevConnId = prevEl && typeof prevEl.getConnectionId === 'function' ? prevEl.getConnectionId() : '';
				const prevDb = prevEl && typeof prevEl.getDatabase === 'function' ? prevEl.getDatabase() : '';
				if (prevConnId) {
					let prevClusterUrl = '';
					try {
						const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '') === prevConnId) : null;
						prevClusterUrl = conn ? String(conn.clusterUrl || '') : '';
					} catch (e) { console.error('[kusto]', e); }
					if (prevClusterUrl && kwEl && typeof kwEl.setDesiredClusterUrl === 'function') {
						kwEl.setDesiredClusterUrl(prevClusterUrl);
					}
					if (prevDb && kwEl && typeof kwEl.setDesiredDatabase === 'function') {
						kwEl.setDesiredDatabase(prevDb);
					}
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Apply desired cluster/database from options BEFORE updateConnectionSelects(),
	// because setConnections() → connection-changed → cached DB load → setDatabases()
	// all run synchronously inside updateConnectionSelects. If _desiredDatabase isn't
	// set yet, the global lastDatabase would be applied instead (wrong database bug).
	try {
		if (kwEl && options) {
			if (options.clusterUrl && typeof kwEl.setDesiredClusterUrl === 'function') {
				kwEl.setDesiredClusterUrl(String(options.clusterUrl));
			}
			if (options.database && typeof kwEl.setDesiredDatabase === 'function') {
				kwEl.setDesiredDatabase(String(options.database));
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	updateConnectionSelects();
	// For newly added sections, if the prefilled cluster+db matches an existing favorite,
	// automatically switch to Favorites mode.
	try {
		if (!isComparison) {
			__kustoMarkNewBoxForFavoritesAutoEnter(id);
			__kustoTryAutoEnterFavoritesModeForNewBox(id);
		}
	} catch (e) { console.error('[kusto]', e); }
	// If this is the first section and the user has favorites, default to Favorites mode.
	// (Otherwise, keep the normal cluster+database dropdowns visible.)
	try {
		if (isFirstBox && typeof window.__kustoMaybeDefaultFirstBoxToFavoritesMode === 'function') {
			window.__kustoMaybeDefaultFirstBoxToFavoritesMode();
		}
	} catch (e) { console.error('[kusto]', e); }
	_win.initQueryEditor(id);

	// Default visibility state (results + comparison summary)
	try {
		if (!pState.resultsVisibleByBoxId || typeof pState.resultsVisibleByBoxId !== 'object') {
			pState.resultsVisibleByBoxId = {};
		}
		pState.resultsVisibleByBoxId[id] = defaultResultsVisible;
	} catch (e) { console.error('[kusto]', e); }
	// Default section visibility state (expanded/collapsed)
	try {
		if (!window.__kustoQueryExpandedByBoxId || typeof window.__kustoQueryExpandedByBoxId !== 'object') {
			window.__kustoQueryExpandedByBoxId = {};
		}
		window.__kustoQueryExpandedByBoxId[id] = defaultExpanded;
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		window.__kustoComparisonSummaryVisibleByBoxId[id] = isComparison ? true : defaultComparisonSummaryVisible;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryVisibilityToggleButton(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyQueryBoxVisibility(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryResultsToggleButton(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateComparisonSummaryToggleButton(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyResultsVisibility(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyComparisonSummaryVisibility(id); } catch (e) { console.error('[kusto]', e); }

	// Drag handle resize for results output.
	try {
		const wrapper = document.getElementById(id + '_results_wrapper') as any;
		const resizer = document.getElementById(id + '_results_resizer') as any;
		if (wrapper && resizer) {
			const computeResizeBounds = () => {
				let minHeight = 120;
				let maxHeight = 900;
				try {
					const resultsEl = document.getElementById(id + '_results') as any;
					// Detect table content: legacy .table-container OR <kw-data-table> element.
					const hasLegacyTable = !!(resultsEl && resultsEl.querySelector && resultsEl.querySelector('.table-container'));
					const dataTableEl = resultsEl && resultsEl.querySelector ? resultsEl.querySelector('kw-data-table') : null;
					if (hasLegacyTable) {
						return { minHeight, maxHeight };
					}
					// <kw-data-table>: cap maxHeight to fit all rows (no blank space below).
					if (dataTableEl) {
						try {
							if (typeof dataTableEl.getContentHeight === 'function') {
								const contentH = dataTableEl.getContentHeight();
								if (contentH > 0) {
									// Add wrapper chrome: resizer + border-top.
									const resizerEl = document.getElementById(id + '_results_resizer') as any;
									const resizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 1;
									maxHeight = Math.max(minHeight, Math.min(900, contentH + resizerH + 1));
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						return { minHeight, maxHeight };
					}
					if (!resultsEl) {
						return { minHeight, maxHeight };
					}

					const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
					const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
					const overheadPx = Math.max(0, wrapperH - resultsClientH);

					let contentPx = 0;
					const children = resultsEl.children ? Array.from(resultsEl.children) : [];
					if (children.length) {
						for (const child of children as any[]) {
							try {
								const rectH = Math.max(0, Math.ceil(child.getBoundingClientRect().height || 0));
								let margin = 0;
								try {
									const cs = getComputedStyle(child);
									margin += parseFloat(cs.marginTop || '0') || 0;
									margin += parseFloat(cs.marginBottom || '0') || 0;
								} catch (e) { console.error('[kusto]', e); }
								contentPx += rectH + Math.ceil(margin);
							} catch (e) { console.error('[kusto]', e); }
						}
					} else {
						const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
						contentPx = headerEl ? Math.max(0, Math.ceil(headerEl.getBoundingClientRect().height || 0)) : 0;
					}

					const desiredPx = Math.max(0, Math.ceil(overheadPx + contentPx + 8));
					maxHeight = Math.min(900, desiredPx);
					minHeight = Math.min(maxHeight, Math.max(24, Math.ceil(overheadPx + 8)));
				} catch (e) { console.error('[kusto]', e); }
				return { minHeight, maxHeight };
			};

			resizer.addEventListener('mousedown', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch (e) { console.error('[kusto]', e); }
				try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + getScrollY();
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						maybeAutoScrollWhileDragging(moveEvent.clientY);
					} catch (e) { console.error('[kusto]', e); }
					const pageY = moveEvent.clientY + getScrollY();
					const delta = pageY - startPageY;
					const bounds = computeResizeBounds();
					const minHeight = (bounds && typeof bounds.minHeight === 'number') ? bounds.minHeight : 24;
					const maxHeight = (bounds && typeof bounds.maxHeight === 'number') ? bounds.maxHeight : 900;
					const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try {
						// Ensure we never leave slack after a drag on error-only content.
						__kustoClampResultsWrapperHeight(id);
					} catch (e) { console.error('[kusto]', e); }
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click on the results resizer: auto-size results to fit contents.
			resizer.addEventListener('dblclick', () => {
				try {
					__kustoAutoSizeResults(id);
				} catch (e) { console.error('[kusto]', e); }
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			});
		}
	} catch (e) { console.error('[kusto]', e); }

	// Assign the window bridge for __kustoClampResultsWrapperHeight (defined at module scope).
	try {
		window.__kustoClampResultsWrapperHeight = __kustoClampResultsWrapperHeight;
	} catch (e) { console.error('[kusto]', e); }
	
	// Set initial query text if provided — use the pending-text map so the Monaco editor
	// picks it up reliably during async initialization (instead of a fragile setTimeout).
	if (initialQuery) {
		try {
			pState.pendingQueryTextByBoxId = pState.pendingQueryTextByBoxId || {};
			pState.pendingQueryTextByBoxId[id] = initialQuery;
		} catch (e) { console.error('[kusto]', e); }
	}
	
	// Check Copilot availability for this box
	try {
		postMessageToHost({
			type: 'checkCopilotAvailability',
			boxId: id
		});
	} catch (e) { console.error('[kusto]', e); }
	
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	// Scroll so the newly created section is visible.
	// Comparison boxes will be repositioned next to the source and scrolled there instead.
	if (!isComparison && afterBoxId) {
		try {
			const newEl = document.getElementById(id);
			if (newEl && typeof newEl.scrollIntoView === 'function') {
				newEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	return id;
}

export function __kustoAutoSizeEditor( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_query_editor') as any;
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;
	const apply = () => {
		try {
			const ed = (typeof queryEditors === 'object' && queryEditors) ? queryEditors[id] : null;
			if (!ed) return;
			let contentHeight = 0;
			try {
				const ch = (typeof ed.getContentHeight === 'function') ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch (e) { console.error('[kusto]', e); }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			const addVisibleRectHeight = (el: any) => {
				try {
					if (!el) return 0;
					const cs = getComputedStyle(el);
					if (cs && cs.display === 'none') return 0;
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					let margin = 0;
					try { margin += parseFloat(cs.marginTop || '0') || 0; margin += parseFloat(cs.marginBottom || '0') || 0; } catch (e) { console.error('[kusto]', e); }
					return Math.max(0, Math.ceil(h + margin));
				} catch { return 0; }
			};

			let chrome = 0;
			try { chrome += addVisibleRectHeight(wrapper.querySelector ? wrapper.querySelector('.query-editor-toolbar') : null); } catch (e) { console.error('[kusto]', e); }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch (e) { console.error('[kusto]', e); }

			let clipExtras = 0;
			try {
				const clip = editorEl.closest ? editorEl.closest('.qe-editor-clip') : null;
				if (clip && clip.children) {
					for (const child of Array.from(clip.children)) {
						if (!child || child === editorEl) continue;
						clipExtras += addVisibleRectHeight(child);
					}
				}
				if (clip) {
					const csc = getComputedStyle(clip);
					clipExtras += (parseFloat(csc.paddingTop || '0') || 0) + (parseFloat(csc.paddingBottom || '0') || 0);
					clipExtras += (parseFloat(csc.borderTopWidth || '0') || 0) + (parseFloat(csc.borderBottomWidth || '0') || 0);
				}
			} catch (e) { console.error('[kusto]', e); }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + clipExtras + contentHeight + FIT_SLACK_PX)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			try { if (wrapper.dataset) { wrapper.dataset.kustoUserResized = 'true'; try { delete wrapper.dataset.kustoAutoResized; } catch (e) { console.error('[kusto]', e); } } } catch (e) { console.error('[kusto]', e); }
			try {
				if (!pState.manualQueryEditorHeightPxByBoxId || typeof pState.manualQueryEditorHeightPxByBoxId !== 'object') {
					pState.manualQueryEditorHeightPxByBoxId = {};
				}
				pState.manualQueryEditorHeightPxByBoxId[id] = desired;
			} catch (e) { console.error('[kusto]', e); }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};
	const applyAndPersist = () => { apply(); try { schedulePersist(); } catch (e) { console.error('[kusto]', e); } };
	try { applyAndPersist(); setTimeout(applyAndPersist, 50); setTimeout(applyAndPersist, 150); } catch (e) { console.error('[kusto]', e); }
}

function __kustoAutoSizeResults( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const w = document.getElementById(id + '_results_wrapper') as any;
	const resultsEl = document.getElementById(id + '_results') as any;
	if (!w || !resultsEl) return;
	try { if (getComputedStyle(w).display === 'none') return; } catch (e) { console.error('[kusto]', e); }

	const dataTableEl = resultsEl.querySelector ? resultsEl.querySelector('kw-data-table') : null;
	if (dataTableEl && typeof dataTableEl.getContentHeight === 'function') {
		const contentH = dataTableEl.getContentHeight();
		if (contentH > 0) {
			// Wrapper chrome: resizer + border-top.
			const resizerEl = document.getElementById(id + '_results_resizer') as any;
			const risizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 1;
			const wrapperBorder = 1;
			const desiredPx = contentH + risizerH + wrapperBorder;
			// Cap: show at most 10 visible rows.
			const MAX_AUTO_ROWS = 10;
			const ROW_H = 27;
			const TABLE_CHROME = 120;
			const MAX_AUTO_H = TABLE_CHROME + (MAX_AUTO_ROWS * ROW_H);
			w.style.height = Math.max(120, Math.min(MAX_AUTO_H, Math.ceil(desiredPx))) + 'px';
			w.style.minHeight = '0';
			try { if (w.dataset) w.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
		}
		return;
	}

	// Legacy fallback for non-kw-data-table results (errors, old table-container, etc.)
	try {
		let chrome = 0;
		try {
			for (const child of Array.from(w.children || []) as any[]) {
				if (!child || child === resultsEl) continue;
				try { if (getComputedStyle(child).display === 'none') continue; } catch (e) { console.error('[kusto]', e); }
				chrome += (child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0);
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const csw = getComputedStyle(w);
			chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
			chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
		} catch (e) { console.error('[kusto]', e); }

		let contentH = 0;
		try {
			for (const child of Array.from(resultsEl.children || []) as any[]) {
				try {
					const cs = getComputedStyle(child);
					if (cs && cs.display === 'none') continue;
					const h = child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0;
					const margin = (parseFloat(cs.marginTop || '0') || 0) + (parseFloat(cs.marginBottom || '0') || 0);
					contentH += Math.ceil(h + margin);
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		if (contentH > 0) {
			const desiredPx = Math.max(24, Math.min(900, Math.ceil(chrome + contentH + 8)));
			w.style.height = desiredPx + 'px';
			w.style.minHeight = '0';
			try { if (w.dataset) w.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoMaximizeQueryBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;

	// 1. Auto-size the Monaco editor.
	__kustoAutoSizeEditor(id);

	// 2. Auto-size the tabular results.
	__kustoAutoSizeResults(id);
	setTimeout(() => __kustoAutoSizeResults(id), 50);
	setTimeout(() => __kustoAutoSizeResults(id), 150);

	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoUpdateQueryVisibilityToggleButton( boxId: any) {
	// Toggle button is now in shadow DOM — the Lit element handles its own rendering
	// based on the _expanded state. Nothing to do here.
}

function __kustoApplyQueryBoxVisibility( boxId: any) {
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (!kwEl) return;
	let expanded = true;
	try {
		expanded = !(window.__kustoQueryExpandedByBoxId && window.__kustoQueryExpandedByBoxId[boxId] === false);
	} catch (e) { console.error('[kusto]', e); }
	if (typeof kwEl.setExpanded === 'function') {
		kwEl.setExpanded(expanded);
	}
	// Monaco often needs a layout pass after being hidden/shown.
	if (expanded) {
		try {
			setTimeout(() => {
				try {
					const ed = (typeof queryEditors === 'object' && queryEditors) ? queryEditors[boxId] : null;
					if (ed && typeof ed.layout === 'function') {
						ed.layout();
					}
					if (!pState.restoreInProgress && typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
						window.__kustoUpdateSchemaForFocusedBox(boxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
			}, 0);
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function toggleQueryBoxVisibility( boxId: any) {
	try {
		if (!window.__kustoQueryExpandedByBoxId || typeof window.__kustoQueryExpandedByBoxId !== 'object') {
			window.__kustoQueryExpandedByBoxId = {};
		}
		const current = !(window.__kustoQueryExpandedByBoxId[boxId] === false);
		window.__kustoQueryExpandedByBoxId[boxId] = !current;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyQueryBoxVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// Result visibility, comparison, optimization, and execution functions
// are in query-execution.controller.ts.

export async function fullyQualifyTablesInEditor( boxId: any) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!database) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	const conn = (connections || []).find((c: any) => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { postMessageToHost({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	const currentSchema = schemaByBoxId ? schemaByBoxId[boxId] : null;
	const currentTables = currentSchema && Array.isArray(currentSchema.tables) ? currentSchema.tables : null;
	if (!currentTables || currentTables.length === 0) {
		// Best-effort: request schema fetch and ask the user to retry.
		try { ensureSchemaForBox(boxId); } catch (e) { console.error('[kusto]', e); }
		try { postMessageToHost({ type: 'showInfo', message: 'Schema not loaded yet. Wait for "Schema loaded" then try again.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	const text = model.getValue() || '';
	const next = await qualifyTablesInTextPriority(text, {
		boxId,
		connectionId,
		currentDatabase: database,
		currentClusterUrl: clusterUrl,
		currentTables
	});
	if (next === text) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch (e) { console.error('[kusto]', e); }
}

async function qualifyTablesInTextPriority( text: any, opts: any) {
	const normalizeClusterForKusto = (clusterUrl: any) => {
		let s = String(clusterUrl || '')
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
			.replace(/:\d+$/, '');
		// Azure Data Explorer public cloud clusters
		s = s.replace(/\.kusto\.windows\.net$/i, '');
		return s;
	};

	const currentTables = (opts.currentTables || []).map((t: any) => String(t));
	const currentTableLower = new Set(currentTables.map((t: any) => t.toLowerCase()));

	// Prefer language service to find true table-reference ranges (instead of regex/lexer guessing).
	let candidates = [];
	try {
		if (typeof window.__kustoRequestKqlTableReferences === 'function') {
			const res = await window.__kustoRequestKqlTableReferences({
				text,
				connectionId: opts.connectionId,
				database: opts.currentDatabase,
				boxId: opts.boxId
			});
			const refs = res && Array.isArray(res.references) ? res.references : null;
			if (refs && refs.length) {
				candidates = refs
					.map((r: any) => ({ value: String(r.name || ''), start: Number(r.startOffset), end: Number(r.endOffset) }))
					.filter((r: any) => r.value && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Fallback: previous best-effort lexer (kept for resilience).
	if (!candidates.length) {
		const isIdentChar = (ch: any) => /[A-Za-z0-9_\-]/.test(ch);
		const skipNames = new Set();
		const tokens = [];
		{
			let i = 0;
			let inS = false;
			let inLineComment = false;
			let inBlockComment = false;
			while (i < text.length) {
				const ch = text[i];
				const next = text[i + 1];
				if (inLineComment) {
					if (ch === '\n') inLineComment = false;
					i++;
					continue;
				}
				if (inBlockComment) {
					if (ch === '*' && next === '/') {
						inBlockComment = false;
						i += 2;
						continue;
					}
					i++;
					continue;
				}
				if (inS) {
					if (ch === "'") {
						inS = false;
					}
					i++;
					continue;
				}
				if (ch === '/' && next === '/') {
					inLineComment = true;
					i += 2;
					continue;
				}
				if (ch === '/' && next === '*') {
					inBlockComment = true;
					i += 2;
					continue;
				}
				if (ch === "'") {
					inS = true;
					i++;
					continue;
				}
				if ((ch === '_' || /[A-Za-z]/.test(ch)) && !inS) {
					let j = i + 1;
					while (j < text.length && isIdentChar(text[j])) j++;
					const value = text.slice(i, j);
					tokens.push({ value, start: i, end: j });
					i = j;
					continue;
				}
				i++;
			}
		}

		for (let idx = 0; idx < tokens.length; idx++) {
			const t = tokens[idx];
			if (!t || String(t.value).toLowerCase() !== 'let') {
				continue;
			}
			const nameTok = tokens[idx + 1];
			if (!nameTok) continue;
			let k = nameTok.end;
			while (k < text.length && /\s/.test(text[k])) k++;
			if (text[k] === '=') {
				skipNames.add(nameTok.value);
			}
		}

		for (const tok of tokens) {
			if (skipNames.has(tok.value)) {
				continue;
			}
			// Skip if already qualified (immediate '.' before name).
			let p = tok.start - 1;
			while (p >= 0 && text[p] === ' ') p--;
			if (p >= 0 && text[p] === '.') {
				continue;
			}
			// Skip if this looks like a function call.
			let a = tok.end;
			while (a < text.length && text[a] === ' ') a++;
			if (text[a] === '(') {
				continue;
			}
			candidates.push(tok);
		}
	}

	if (!candidates.length) {
		return text;
	}

	// Resolve each distinct candidate name to its best fully-qualified reference.
	const unresolvedLower = new Set();
	for (const c of candidates) {
		unresolvedLower.add(String(c.value).toLowerCase());
	}
	const resolvedLocationByLower = new Map();
	const fq = (clusterUrl: any, database: any, table: any) => {
		const c = normalizeClusterForKusto(clusterUrl);
		return "cluster('" + c + "').database('" + database + "')." + table;
	};

	const markResolved = (lowerName: any, clusterUrl: any, database: any) => {
		if (!lowerName || resolvedLocationByLower.has(lowerName)) {
			return;
		}
		resolvedLocationByLower.set(lowerName, {
			clusterUrl: String(clusterUrl || ''),
			database: String(database || '')
		});
		unresolvedLower.delete(lowerName);
	};

	// Priority 1: current DB (cached).
	for (const lowerName of Array.from(unresolvedLower)) {
		if (currentTableLower.has(lowerName)) {
			markResolved(lowerName, opts.currentClusterUrl, opts.currentDatabase);
		}
	}

	const requestSchema = async (connectionId: any, database: any) => {
		try {
			if (typeof window.__kustoRequestSchema === 'function') {
				const sch = await window.__kustoRequestSchema(connectionId, database, false);
				try {
					const cid = String(connectionId || '').trim();
					const db = String(database || '').trim();
					if (cid && db && sch) {
						schemaByConnDb[cid + '|' + db] = sch;
					}
				} catch (e) { console.error('[kusto]', e); }
				return sch;
			}
		} catch (e) { console.error('[kusto]', e); }
		return null;
	};

	const requestDatabases = async (connectionId: any, forceRefresh: any) => {
		try {
			return await __kustoRequestDatabases(connectionId, !!forceRefresh);
		} catch (e) { console.error('[kusto]', e); }
		try {
			const cid = String(connectionId || '').trim();
			let clusterKey = '';
			try {
				const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
				const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
				if (clusterUrl) {
					let u = clusterUrl;
					if (!/^https?:\/\//i.test(u)) {
						u = 'https://' + u;
					}
					try {
						clusterKey = String(new URL(u).hostname || '').trim().toLowerCase();
					} catch {
						clusterKey = String(clusterUrl || '').trim().toLowerCase();
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			const cached = cachedDatabases && cachedDatabases[String(clusterKey || '').trim()];
			return Array.isArray(cached) ? cached : [];
		} catch {
			return [];
		}
	};

	const schemaTablesLowerCache = new WeakMap();
	const getSchemaTableLowerSet = (schema: any) => {
		if (!schema || typeof schema !== 'object') return null;
		try {
			const cached = schemaTablesLowerCache.get(schema);
			if (cached) return cached;
			const tables = Array.isArray(schema.tables) ? schema.tables : [];
			const setLower = new Set(tables.map((t: any) => String(t).toLowerCase()));
			schemaTablesLowerCache.set(schema, setLower);
			return setLower;
		} catch {
			return null;
		}
	};

	const tryResolveFromSchema = (schema: any, clusterUrl: any, dbName: any) => {
		if (!schema || !dbName || unresolvedLower.size === 0) {
			return;
		}
		const tableLowerSet = getSchemaTableLowerSet(schema);
		if (!tableLowerSet) {
			return;
		}
		for (const lowerName of Array.from(unresolvedLower)) {
			if (tableLowerSet.has(lowerName)) {
				markResolved(lowerName, clusterUrl, dbName);
			}
		}
	};

	const scanCachedSchemasForMatches = (schemas: any, clusterUrl: any) => {
		for (const entry of schemas) {
			if (!entry) continue;
			const dbName = String(entry.database || '').trim();
			const schema = entry.schema;
			if (!dbName || !schema) continue;
			tryResolveFromSchema(schema, clusterUrl, dbName);
			if (unresolvedLower.size === 0) return;
		}
	};

	const getCachedSchemasForConnection = (connectionId: any) => {
		const cid = String(connectionId || '').trim();
		if (!cid) return [];
		const prefix = cid + '|';
		const list = [];
		try {
			for (const key of Object.keys(schemaByConnDb || {})) {
				if (!key || !key.startsWith(prefix)) continue;
				const dbName = key.slice(prefix.length);
				if (!dbName) continue;
				list.push({ database: dbName, schema: schemaByConnDb[key] });
			}
		} catch (e) { console.error('[kusto]', e); }
		list.sort((a: any, b: any) => String(a.database).toLowerCase().localeCompare(String(b.database).toLowerCase()));
		return list;
	};

	// Step 2: search all cached schemas in priority order.
	// Priority 2: current cluster (cached).
	if (unresolvedLower.size > 0) {
		const cachedCurrentConn = getCachedSchemasForConnection(opts.connectionId)
			.filter((e: any) => String(e.database) !== String(opts.currentDatabase));
		scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
	}

	// Priority 3: across all clusters (cached).
	if (unresolvedLower.size > 0) {
		const connById = new Map();
		try {
			for (const c of (connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch (e) { console.error('[kusto]', e); }

		// Deterministic: iterate connections sorted by display clusterUrl.
		const otherConns = Array.from(connById.entries())
			.filter(([cid]) => cid !== String(opts.connectionId || '').trim())
			.map(([cid, c]) => ({ cid, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter((x: any) => !!x.clusterUrl)
			.sort((a: any, b: any) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

		for (const c of otherConns) {
			if (unresolvedLower.size === 0) break;
			const cached = getCachedSchemasForConnection(c.cid);
			scanCachedSchemasForMatches(cached, c.clusterUrl);
		}
	}

	// Step 3: if still unmatched, fetch missing schemas, then repeat Step 2 against the newly-cached data.
	if (unresolvedLower.size > 0) {
		// Fetch missing schemas for current connection first.
		const cid = String(opts.connectionId || '').trim();
		let dbs = await requestDatabases(cid, false);
		for (const db of (Array.isArray(dbs) ? dbs : [])) {
			if (unresolvedLower.size === 0) break;
			const dbName = String(db || '').trim();
			if (!dbName || dbName === String(opts.currentDatabase)) continue;
			const key = cid + '|' + dbName;
			if (schemaByConnDb && schemaByConnDb[key]) continue;
			const sch = await requestSchema(cid, dbName);
			tryResolveFromSchema(sch, opts.currentClusterUrl, dbName);
		}

		// Re-scan cached current cluster after fetch.
		if (unresolvedLower.size > 0) {
			const cachedCurrentConn = getCachedSchemasForConnection(cid)
				.filter((e: any) => String(e.database) !== String(opts.currentDatabase));
			scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
		}
	}

	if (unresolvedLower.size > 0) {
		// Fetch missing schemas for other connections.
		const connById = new Map();
		try {
			for (const c of (connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		const otherConns = Array.from(connById.entries())
			.filter(([id]) => id !== String(opts.connectionId || '').trim())
			.map(([id, c]) => ({ cid: id, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter((x: any) => !!x.clusterUrl)
			.sort((a: any, b: any) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

		for (const c of otherConns) {
			if (unresolvedLower.size === 0) break;
			let dbs = await requestDatabases(c.cid, false);
			for (const db of (Array.isArray(dbs) ? dbs : [])) {
				if (unresolvedLower.size === 0) break;
				const dbName = String(db || '').trim();
				if (!dbName) continue;
				const key = c.cid + '|' + dbName;
				if (schemaByConnDb && schemaByConnDb[key]) continue;
				const sch = await requestSchema(c.cid, dbName);
				tryResolveFromSchema(sch, c.clusterUrl, dbName);
			}

			// Re-scan cached for this connection after fetch.
			if (unresolvedLower.size > 0) {
				const cached = getCachedSchemasForConnection(c.cid);
				scanCachedSchemasForMatches(cached, c.clusterUrl);
			}
		}
	}

	// Apply replacements from end to start.
	const replacements = [];
	for (const tok of candidates) {
		const lower = String(tok.value).toLowerCase();
		const loc = resolvedLocationByLower.get(lower);
		if (!loc || !loc.clusterUrl || !loc.database) continue;
		replacements.push({ start: tok.start, end: tok.end, fq: fq(loc.clusterUrl, loc.database, String(tok.value)) });
	}
	if (!replacements.length) {
		return text;
	}

	let out = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		out = out.slice(0, r.start) + r.fq + out.slice(r.end);
	}
	return out;
}

export function removeQueryBox( boxId: any) {
	// Dispose Copilot chat state for this query box (if present).
	try {
		const kwEl = window.__kustoGetQuerySectionElement ? window.__kustoGetQuerySectionElement(boxId) : null;
		if (kwEl && typeof kwEl.disposeCopilotChat === 'function') {
			kwEl.disposeCopilotChat();
		}
	} catch (e) { console.error('[kusto]', e); }

	// If removing a linked optimized box, exit linked optimization mode and restore cache settings.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
					try { __kustoSetLinkedOptimizationMode(sourceBoxId, boxId, false); } catch (e) { console.error('[kusto]', e); }
				try { delete optimizationMetadataByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
				try { delete optimizationMetadataByBoxId[sourceBoxId]; } catch (e) { console.error('[kusto]', e); }
			} else if (meta && meta.comparisonBoxId) {
				// If removing the source box, remove the comparison box too.
				const comparisonBoxId = meta.comparisonBoxId;
					try { __kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, false); } catch (e) { console.error('[kusto]', e); }
				try { removeQueryBox(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
				try { delete optimizationMetadataByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Stop any running timer/spinner for this box
	setQueryExecuting(boxId, false);
	delete runModesByBoxId[boxId];
	try {
		if (pState.queryResultJsonByBoxId) {
			delete pState.queryResultJsonByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }

	// Disconnect any resize observer
	if (queryEditorResizeObservers[boxId]) {
		try {
			queryEditorResizeObservers[boxId].disconnect();
		} catch (e) { console.error('[kusto]', e); }
		delete queryEditorResizeObservers[boxId];
	}

	// Disconnect any visibility observers
	try {
		if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers && queryEditorVisibilityObservers[boxId]) {
			try { queryEditorVisibilityObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			delete queryEditorVisibilityObservers[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers && queryEditorVisibilityMutationObservers[boxId]) {
			try { queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			delete queryEditorVisibilityMutationObservers[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }

	// Dispose editor if present
	if (queryEditors[boxId]) {
		try {
			queryEditors[boxId].dispose();
		} catch (e) { console.error('[kusto]', e); }
		delete queryEditors[boxId];
	}

	// Remove from tracked list
	setQueryBoxes(queryBoxes.filter((id: any) => id !== boxId));
	try { delete lastQueryTextByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	try { delete missingClusterUrlsByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	try {
		if (missingClusterDetectTimersByBoxId && missingClusterDetectTimersByBoxId[boxId]) {
			clearTimeout(missingClusterDetectTimersByBoxId[boxId]);
			delete missingClusterDetectTimersByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }

	// Clear any global pointers if they reference this box
	if (pState.lastExecutedBox === boxId) {
		pState.lastExecutedBox = null;
	}
	if (currentResult && currentResult.boxId === boxId) {
		resetCurrentResult();
	}

	// Remove DOM node
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function toggleCachePill( boxId: any) {
	const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
	const label = document.getElementById(boxId + '_cache_label') as any;
	if (label) {
		label.classList.toggle('disabled', !checkbox.checked);
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function toggleCachePopup( boxId: any) {
	const popup = document.getElementById(boxId + '_cache_popup') as any;
	if (!popup) return;

	const isOpen = popup.classList.contains('open');

	// Close all other popups first (and clean up their listeners)
	document.querySelectorAll('.cache-popup.open').forEach((p: any) => {
		if (p !== popup) {
			if (p._kustoCacheClose) p._kustoCacheClose();
			else p.classList.remove('open');
		}
	});

	if (isOpen) {
		// Closing — clean up listeners
		if (popup._kustoCacheClose) popup._kustoCacheClose();
		else popup.classList.remove('open');
		return;
	}

	popup.classList.add('open');

	// Capture scroll position for threshold-based dismiss (interactive — 20px)
	const scrollAtOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;

	const closePopup = () => {
		popup.classList.remove('open');
		delete popup._kustoCacheClose;
		document.removeEventListener('click', clickHandler);
		document.removeEventListener('scroll', scrollHandler, true);
		document.removeEventListener('wheel', wheelHandler, true);
	};

	popup._kustoCacheClose = closePopup;

	const clickHandler = (e: any) => {
		try {
			if (!popup.contains(e.target) && !(e.target.closest && e.target.closest('#' + boxId + '_cache_label'))) {
				closePopup();
			}
		} catch { closePopup(); }
	};

	const scrollHandler = () => {
		try {
			const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
			if (Math.abs(scrollY - scrollAtOpen) > 20) {
				closePopup();
			}
		} catch (e) { console.error('[kusto]', e); }
	};

	const wheelHandler = (e: any) => {
		try {
			// Allow wheel inside the popup (e.g. number input spin)
			if (popup.contains(e.target)) return;
			closePopup();
		} catch { closePopup(); }
	};

	// Delay click listener to avoid closing from the opening click
	setTimeout(() => { document.addEventListener('click', clickHandler); }, 0);
	document.addEventListener('scroll', scrollHandler, true);
	document.addEventListener('wheel', wheelHandler, { passive: true, capture: true } as any);
}

// Keep for backward compatibility
export function toggleCacheControls( boxId: any) {
	toggleCachePill(boxId);
}


// ── Connection, favorites & schema management — sections/query-connection.controller.ts ──
import {
	computeMissingClusterUrls, updateMissingClustersForBox,
	__kustoOnConnectionsUpdated,
	__kustoFindConnectionIdForClusterUrl, __kustoGetCurrentClusterUrlForBox, __kustoGetCurrentDatabaseForBox,
	__kustoFindFavorite, __kustoSetAutoEnterFavoritesForBox,
	__kustoTryAutoEnterFavoritesModeForAllBoxes, __kustoMaybeDefaultFirstBoxToFavoritesMode,
	__kustoUpdateFavoritesUiForAllBoxes,
	addMissingClusterConnections, updateConnectionSelects,
	promptAddConnectionFromDropdown, importConnectionsFromXmlFile,
	parseKustoExplorerConnectionsXml,
	refreshDatabases, onDatabasesError, updateDatabaseSelect,
	ensureSchemaForBox, onDatabaseChanged, refreshSchema,
	__kustoRequestSchema, __kustoRequestDatabases,
	toggleFavoriteForBox, removeFavorite, closeAllFavoritesDropdowns,
	__kustoUpdateFavoritesUiForBox, __kustoMarkNewBoxForFavoritesAutoEnter,
	__kustoTryAutoEnterFavoritesModeForNewBox,
} from '../sections/query-connection.controller';
// Re-export for other modules that import from section-factory
export {
	computeMissingClusterUrls, updateMissingClustersForBox,
	__kustoOnConnectionsUpdated,
	__kustoFindConnectionIdForClusterUrl, __kustoGetCurrentClusterUrlForBox, __kustoGetCurrentDatabaseForBox,
	__kustoFindFavorite, __kustoSetAutoEnterFavoritesForBox,
	__kustoTryAutoEnterFavoritesModeForAllBoxes, __kustoMaybeDefaultFirstBoxToFavoritesMode,
	__kustoUpdateFavoritesUiForAllBoxes,
	addMissingClusterConnections, updateConnectionSelects,
	promptAddConnectionFromDropdown, importConnectionsFromXmlFile,
	parseKustoExplorerConnectionsXml,
	refreshDatabases, onDatabasesError, updateDatabaseSelect,
	ensureSchemaForBox, onDatabaseChanged, refreshSchema,
	__kustoRequestSchema, __kustoRequestDatabases,
	closeAllFavoritesDropdowns,
};
window.addQueryBox = addQueryBox;
window.toggleCachePill = toggleCachePill;
window.toggleCachePopup = toggleCachePopup;
// Schema functions (relocated from schema.ts) — __kustoRequestSchema bridge still needed by completions.
window.__kustoRequestSchema = __kustoRequestSchema;
// Connection/database/favorites bridges — only those with inline onclick consumers.
window.addMissingClusterConnections = addMissingClusterConnections;
window.updateConnectionSelects = updateConnectionSelects;

// ── Copilot chat thin window bridges ──────────────────────────────────────────
// These remain as window globals because they are called from inline onclick
// attributes in HTML strings (queryBoxes.ts toolbar, queryBoxes-toolbar.ts
// overflow menu). The actual logic lives in kw-query-section.

window.__kustoToggleCopilotChatForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const kwEl = window.__kustoGetQuerySectionElement ? window.__kustoGetQuerySectionElement(id) : null;
	if (kwEl && typeof kwEl.toggleCopilotChat === 'function') {
		kwEl.toggleCopilotChat();
	}
};

window.addCopilotQueryBox = function (options: any) {
	const id = addQueryBox(options || {});
	try {
		const kwEl = __kustoGetQuerySectionElement(id);
		if (kwEl && typeof kwEl.installCopilotChat === 'function') {
			kwEl.installCopilotChat();
			kwEl.setCopilotChatVisible(true);
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
};

// ══════════════════════════════════════════════════════════════════════════════
// Extra section creation: Chart, Transformation, Python, URL (from extraBoxes.ts)
// ══════════════════════════════════════════════════════════════════════════════

const __kustoUpdateChartBuilderUI = (boxId: any) => {
	try {
		const fn = (_win as any).__kustoUpdateChartBuilderUI;
		if (typeof fn === 'function') fn(boxId);
	} catch (e) { console.error('[kusto]', e); }
};

const __kustoUpdateTransformationBuilderUI = (boxId: any) => {
	try {
		const fn = (_win as any).__kustoUpdateTransformationBuilderUI;
		if (typeof fn === 'function') fn(boxId);
	} catch (e) { console.error('[kusto]', e); }
};

const __kustoRenderTransformation = (boxId: any) => {
	try {
		const fn = (_win as any).__kustoRenderTransformation;
		if (typeof fn === 'function') fn(boxId);
	} catch (e) { console.error('[kusto]', e); }
};

// Section modules initialize these arrays on window.
// Read references from window so all modules share the same arrays.
let markdownBoxes: any[] = window.__kustoMarkdownBoxes || [];
let chartBoxes: any[] = window.__kustoChartBoxes || [];
let transformationBoxes: any[] = window.__kustoTransformationBoxes || [];

// Python and URL boxes are managed in this file (not sub-modules).
export let pythonBoxes: any[] = [];
export let urlBoxes: any[] = [];
window.__kustoPythonBoxes = pythonBoxes;
window.__kustoUrlBoxes = urlBoxes;

// Expose markdownEditors on window so main.js can access it for tool handlers
window.__kustoMarkdownEditors = window.__kustoMarkdownEditors || {};
let markdownEditors = window.__kustoMarkdownEditors;
let markdownViewers: any = {};
let pythonEditors: any = {};
try { window.__kustoPythonEditors = pythonEditors; } catch (e) { console.error('[kusto]', e); }

// Chart UI state keyed by boxId.
// Explicitly on window so persistence.js can access it
window.chartStateByBoxId = window.chartStateByBoxId || {};
const chartStateByBoxId = window.chartStateByBoxId;

// Transformation UI state keyed by boxId.
// Explicitly on window so persistence.js can access it
window.transformationStateByBoxId = window.transformationStateByBoxId || {};
const transformationStateByBoxId = window.transformationStateByBoxId;

// When query/transform results update, refresh dependent charts/transformations.
let __kustoIsRefreshingDependents = false;
let __kustoPendingDependentRefreshIds: Set<string> = new Set();
let __kustoDependentRefreshTimer: any = null;

function __kustoRefreshDependentExtraBoxes( rootSourceId: any) {
	const root = String(rootSourceId || '');
	if (!root) return;
	if (__kustoIsRefreshingDependents) return;
	__kustoIsRefreshingDependents = true;
	try {
		const queue = [root];
		const visitedSources = new Set();
		const visitedTransformations = new Set();

		while (queue.length) {
			const sourceId = String(queue.shift() || '');
			if (!sourceId || visitedSources.has(sourceId)) {
				continue;
			}
			visitedSources.add(sourceId);

			// Refresh transformations first (they produce new datasets other charts/transforms may depend on).
			try {
				if (transformationStateByBoxId && typeof transformationStateByBoxId === 'object') {
					for (const [boxId, st] of Object.entries(transformationStateByBoxId)) {
						if (!st || typeof st !== 'object') continue;
						const ds = (typeof (st as any).dataSourceId === 'string') ? String((st as any).dataSourceId) : '';
						if (ds !== sourceId) continue;
						if (visitedTransformations.has(boxId)) continue;
						visitedTransformations.add(boxId);
						try { __kustoUpdateTransformationBuilderUI(boxId); } catch (e) { console.error('[kusto]', e); }
						try { __kustoRenderTransformation(boxId); } catch (e) { console.error('[kusto]', e); }
						queue.push(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }

			// Refresh charts that directly depend on this source.
			try {
				if (chartStateByBoxId && typeof chartStateByBoxId === 'object') {
					for (const [boxId, st] of Object.entries(chartStateByBoxId)) {
						if (!st || typeof st !== 'object') continue;
						const ds = (typeof (st as any).dataSourceId === 'string') ? String((st as any).dataSourceId) : '';
						if (ds !== sourceId) continue;
						try { __kustoUpdateChartBuilderUI(boxId); } catch (e) { console.error('[kusto]', e); }
						try { __kustoRenderChart(boxId); } catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} finally {
		__kustoIsRefreshingDependents = false;
	}
}

export function __kustoNotifyResultsUpdated(boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		// Avoid recursion: transformation renders update results too.
		if (__kustoIsRefreshingDependents) return;
		__kustoPendingDependentRefreshIds.add(id);
		if (__kustoDependentRefreshTimer) return;
		__kustoDependentRefreshTimer = setTimeout(() => {
			__kustoDependentRefreshTimer = null;
			const pending = Array.from(__kustoPendingDependentRefreshIds);
			__kustoPendingDependentRefreshIds = new Set();
			for (const rootId of pending) {
				try { __kustoRefreshDependentExtraBoxes(rootId); } catch (e) { console.error('[kusto]', e); }
			}
			// After dependent sections are refreshed, update all data-source dropdowns
			// so newly-available sources (e.g. a transformation that just produced results)
			// appear in chart/transformation pickers.
			try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
}

try {
	window.__kustoNotifyResultsUpdated = __kustoNotifyResultsUpdated;
} catch (e) { console.error('[kusto]', e); }

export function __kustoGetChartDatasetsInDomOrder() {
	const out = [];
	try {
		const container = document.getElementById('queries-container');
		const children = container ? Array.from(container.children || []) as any[] : [];
		// Calculate position among all sections (1-based)
		let sectionIndex = 0;
		for (const child of children) {
			try {
				const id = child && child.id ? String(child.id) : '';
				if (!id) continue;
				// Count all section types for consistent numbering
				if (id.startsWith('query_') || id.startsWith('markdown_') || id.startsWith('python_') || id.startsWith('url_') || id.startsWith('chart_') || id.startsWith('transformation_') || id.startsWith('copilotQuery_')) {
					sectionIndex++;
				}
				// Only include sections that can be data sources
				if (!(id.startsWith('query_') || id.startsWith('url_') || id.startsWith('transformation_'))) continue;
				const st = getResultsState(id);
				const cols = st && Array.isArray(st.columns) ? st.columns : [];
				const rows = st && Array.isArray(st.rows) ? st.rows : [];
				if (!cols.length) continue;
				let name = '';
				try {
					name = typeof (child as any).getName === 'function'
						? String((child as any).getName() || '').trim()
						: String(((document.getElementById(id + '_name') as any || {}).value || '')).trim();
				} catch (e) { console.error('[kusto]', e); }
				// Format: "<Name> [section #N]" if named, "Unnamed [section #N]" if not
				const label = name
					? name + ' [section #' + sectionIndex + ']'
					: 'Unnamed [section #' + sectionIndex + ']';
				out.push({
					id,
					label,
					columns: cols,
					rows
				});
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	return out;
}

/**
 * Refresh all Chart and Transformation section Data dropdowns.
 * Call this after sections are reordered, added, or removed to update position labels.
 */
export function __kustoRefreshAllDataSourceDropdowns() {
	try {
		const container = document.getElementById('queries-container');
		if (!container) return;
		const children = Array.from(container.children || []) as any[];
		for (const child of children) {
			try {
				const id = child && child.id ? String(child.id) : '';
				if (!id) continue;
				if (id.startsWith('chart_')) {
					__kustoUpdateChartBuilderUI(id);
				} else if (id.startsWith('transformation_')) {
					__kustoUpdateTransformationBuilderUI(id);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoConfigureChartFromTool( boxId: any, config: any) {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;
		
		// Ensure state object exists
		const st = __kustoGetChartState(id);
		if (!st) return false;
		
		// Apply configuration properties
		if (typeof config.dataSourceId === 'string') {
			st.dataSourceId = config.dataSourceId;
		}
		if (typeof config.chartType === 'string') {
			st.chartType = config.chartType;
		}
		if (typeof config.xColumn === 'string') {
			st.xColumn = config.xColumn;
		}
		if (Array.isArray(config.yColumns)) {
			st.yColumns = config.yColumns.map((c: any) => String(c));
			// Keep st.yColumn in sync for heatmap validation
			st.yColumn = st.yColumns.length ? st.yColumns[0] : '';
		} else if (typeof config.yColumn === 'string') {
			// Support single yColumn for backwards compat
			st.yColumns = [config.yColumn];
			st.yColumn = config.yColumn;
		}
		if (typeof config.labelColumn === 'string') {
			st.labelColumn = config.labelColumn;
		}
		if (typeof config.valueColumn === 'string') {
			st.valueColumn = config.valueColumn;
		}
		if (typeof config.legendColumn === 'string') {
			st.legendColumn = config.legendColumn;
		}
		if (Array.isArray(config.tooltipColumns)) {
			st.tooltipColumns = config.tooltipColumns.map((c: any) => String(c));
		}
		if (typeof config.showDataLabels === 'boolean') {
			st.showDataLabels = config.showDataLabels;
		}
		if (typeof config.legendPosition === 'string') {
			st.legendPosition = config.legendPosition;
		}
		if (typeof config.sortColumn === 'string') {
			st.sortColumn = config.sortColumn;
		}
		if (typeof config.sortDirection === 'string') {
			st.sortDirection = config.sortDirection;
		}
		if (typeof config.sourceColumn === 'string') {
			st.sourceColumn = config.sourceColumn;
		}
		if (typeof config.targetColumn === 'string') {
			st.targetColumn = config.targetColumn;
		}
		if (typeof config.orient === 'string') {
			st.orient = config.orient;
		}
		if (typeof config.sankeyLeftMargin === 'number') {
			st.sankeyLeftMargin = config.sankeyLeftMargin;
		}
		if (typeof config.stackMode === 'string') {
			st.stackMode = config.stackMode;
		}
		if (typeof config.labelMode === 'string') {
			st.labelMode = config.labelMode;
		}
		if (typeof config.labelDensity === 'number') {
			st.labelDensity = config.labelDensity;
		}
		if (typeof config.chartTitle === 'string') {
			st.chartTitle = config.chartTitle;
		}
		if (typeof config.chartSubtitle === 'string') {
			st.chartSubtitle = config.chartSubtitle;
		}
		if (typeof config.chartTitleAlign === 'string') {
			st.chartTitleAlign = config.chartTitleAlign;
		}
		if (config.xAxisSettings && typeof config.xAxisSettings === 'object') {
			st.xAxisSettings = { ...(st.xAxisSettings || {}), ...config.xAxisSettings };
		}
		if (config.yAxisSettings && typeof config.yAxisSettings === 'object') {
			const yas = { ...config.yAxisSettings };
			// Normalize seriesColors: accept arrays by mapping to yColumns
			if (Array.isArray(yas.seriesColors)) {
				const cols = Array.isArray(st.yColumns) ? st.yColumns : [];
				const obj: Record<string, string> = {};
				for (let i = 0; i < yas.seriesColors.length; i++) {
					const key = cols[i] || `series${i}`;
					obj[key] = String(yas.seriesColors[i]);
				}
				yas.seriesColors = obj;
			}
			st.yAxisSettings = { ...(st.yAxisSettings || {}), ...yas };
		}
		if (config.legendSettings && typeof config.legendSettings === 'object') {
			const ls = { ...config.legendSettings };
			// Normalize sortMode aliases (e.g. "alphabetical" → "alpha-asc")
			if (typeof ls.sortMode === 'string') {
				ls.sortMode = normalizeLegendSortMode(ls.sortMode);
			}
			st.legendSettings = { ...(st.legendSettings || {}), ...ls };
			if (typeof st.legendSettings.position === 'string') st.legendPosition = st.legendSettings.position;
			if (typeof st.legendSettings.stackMode === 'string') st.stackMode = st.legendSettings.stackMode;
		}
		if (config.heatmapSettings && typeof config.heatmapSettings === 'object') {
			st.heatmapSettings = { ...(st.heatmapSettings || {}), ...config.heatmapSettings };
		}
		
		// Update the UI dropdowns to reflect new state and re-render the chart
		try { __kustoUpdateChartBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRenderChart(id); } catch (e) { console.error('[kusto]', e); }
		
		// Persist changes
		try { if (typeof _win.schedulePersist === 'function') _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		
		return true;
	} catch (err: any) {
		console.error('[Kusto] Error configuring chart:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { window.__kustoConfigureChart = __kustoConfigureChartFromTool; } catch (e) { console.error('[kusto]', e); }

export function __kustoGetChartValidationStatus( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return { valid: false, error: 'No chart ID provided' };
		
		const st = __kustoGetChartState(id);
		if (!st) return { valid: false, error: 'Chart section not found' };
		
		const issues = [];
		
		// Check data source
		const dataSourceId = typeof st.dataSourceId === 'string' ? st.dataSourceId : '';
		if (!dataSourceId) {
			issues.push('No data source selected. Use dataSourceId to link to a query section with results.');
		}
		
		// Check chart type
		const chartType = typeof st.chartType === 'string' ? st.chartType : '';
		if (!chartType) {
			issues.push('No chart type selected. Specify chartType (line, area, bar, scatter, pie, funnel, sankey, or heatmap).');
		}
		
		// Check if data source exists and has data
		let dataSourceExists = false;
		let dataSourceHasData = false;
		let availableColumns: any[] = [];
		if (dataSourceId) {
			try {
				const dsState = getResultsState(dataSourceId);
				if (dsState) {
					dataSourceExists = true;
					const cols = Array.isArray(dsState.columns) ? dsState.columns : [];
					const rows = Array.isArray(dsState.rows) ? dsState.rows : [];
					availableColumns = cols.map((c: any) => typeof c === 'string' ? c : String(c?.name || ''));
					dataSourceHasData = cols.length > 0 && rows.length > 0;
					if (!dataSourceHasData) {
						if (cols.length === 0) {
							issues.push(`Data source "${dataSourceId}" has no columns. Execute the query first to get results.`);
						} else if (rows.length === 0) {
							issues.push(`Data source "${dataSourceId}" has columns but no data rows. Execute the query first.`);
						}
					}
				} else {
					issues.push(`Data source "${dataSourceId}" not found or has no results. Make sure the query has been executed.`);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		
		// Check column configuration based on chart type
		if (chartType && dataSourceHasData && availableColumns.length > 0) {
			const xColumn = typeof st.xColumn === 'string' ? st.xColumn : '';
			const yColumns = Array.isArray(st.yColumns) ? st.yColumns : [];
			const labelColumn = typeof st.labelColumn === 'string' ? st.labelColumn : '';
			const valueColumn = typeof st.valueColumn === 'string' ? st.valueColumn : '';
			
			if (chartType === 'pie' || chartType === 'funnel') {
				if (!labelColumn) {
					issues.push(`${chartType} chart requires labelColumn (the category names). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(labelColumn)) {
					issues.push(`labelColumn "${labelColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!valueColumn) {
					issues.push(`${chartType} chart requires valueColumn (the numeric values). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(valueColumn)) {
					issues.push(`valueColumn "${valueColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
			} else if (chartType === 'sankey') {
				const sourceColumn = typeof st.sourceColumn === 'string' ? st.sourceColumn : '';
				const targetColumn = typeof st.targetColumn === 'string' ? st.targetColumn : '';
				if (!sourceColumn) {
					issues.push(`sankey chart requires sourceColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(sourceColumn)) {
					issues.push(`sourceColumn "${sourceColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!targetColumn) {
					issues.push(`sankey chart requires targetColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(targetColumn)) {
					issues.push(`targetColumn "${targetColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!valueColumn) {
					issues.push(`sankey chart requires valueColumn (the numeric flow values). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(valueColumn)) {
					issues.push(`valueColumn "${valueColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
			} else if (chartType === 'heatmap') {
				if (!xColumn) {
					issues.push(`heatmap chart requires xColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(xColumn)) {
					issues.push(`xColumn "${xColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				const yColumn = (typeof st.yColumn === 'string' && st.yColumn)
					? st.yColumn
					: (Array.isArray(st.yColumns) && st.yColumns.length ? String(st.yColumns[0]) : '');
				if (!yColumn) {
					issues.push(`heatmap chart requires yColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(yColumn)) {
					issues.push(`yColumn "${yColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!valueColumn) {
					issues.push(`heatmap chart requires valueColumn (the numeric intensity). Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(valueColumn)) {
					issues.push(`valueColumn "${valueColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
			} else {
				if (!xColumn) {
					issues.push(`${chartType} chart requires xColumn. Available columns: ${availableColumns.join(', ')}`);
				} else if (!availableColumns.includes(xColumn)) {
					issues.push(`xColumn "${xColumn}" not found in data. Available columns: ${availableColumns.join(', ')}`);
				}
				if (!yColumns || yColumns.length === 0) {
					issues.push(`${chartType} chart requires yColumns (array of column names for Y axis). Available columns: ${availableColumns.join(', ')}`);
				} else {
					const invalidYCols = yColumns.filter((c: any) => !availableColumns.includes(c));
					if (invalidYCols.length > 0) {
						issues.push(`yColumns "${invalidYCols.join(', ')}" not found in data. Available columns: ${availableColumns.join(', ')}`);
					}
				}
			}
		}
		
		const valid = issues.length === 0;
		return {
			valid,
			chartType: chartType || null,
			dataSourceId: dataSourceId || null,
			dataSourceExists,
			dataSourceHasData,
			availableColumns: availableColumns.length > 0 ? availableColumns : undefined,
			currentConfig: {
				xColumn: st.xColumn || null,
				yColumns: (Array.isArray(st.yColumns) && st.yColumns.length > 0) ? st.yColumns : null,
				labelColumn: st.labelColumn || null,
				valueColumn: st.valueColumn || null,
				legendColumn: st.legendColumn || null,
				sourceColumn: st.sourceColumn || null,
				targetColumn: st.targetColumn || null
			},
			...(issues.length > 0 ? { issues } : {})
		};
	} catch (err: any) {
		return { valid: false, error: `Validation error: ${err.message || String(err)}` };
	}
}

export function __kustoGetRawCellValueForChart( cell: any) {
	try {
		return _getRawCellValueFromState(cell);
	} catch (e) { console.error('[kusto]', e); }
	return _getRawCellValue(cell);
}

export function __kustoCellToChartString( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		if (raw === null || raw === undefined) return '';
		if (raw instanceof Date) return raw.toISOString();
		if (typeof raw === 'string') return raw;
		if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
		if (typeof raw === 'object') {
			try { return JSON.stringify(raw); } catch { return '[object]'; }
		}
		return String(raw);
	} catch {
		try { return String(cell); } catch { return ''; }
	}
}

export function __kustoCellToChartNumber( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		return tryParseFiniteNumber(raw);
	} catch {
		return null;
	}
}

export function __kustoCellToChartTimeMs( cell: any) {
	try {
		const raw = __kustoGetRawCellValueForChart(cell);
		const d = tryParseDate(raw);
		return d ? d.getTime() : null;
	} catch {
		return null;
	}
}

export function __kustoInferTimeXAxisFromRows( rows: any, xIndex: any) {
	return _inferTimeXAxisFromRows(rows, xIndex);
}

export function __kustoNormalizeResultsColumnName( c: any) {
	return _normalizeResultsColumnName(c);
}

export function __kustoSetSelectOptions( selectEl: any, values: any, selectedValue: any, labelMap?: any) {
	if (!selectEl) return;
	try {
		const selected = (typeof selectedValue === 'string') ? selectedValue : '';
		const opts = Array.isArray(values) ? values : [];
		const labels = (labelMap && typeof labelMap === 'object') ? labelMap : {};
		let html = '';
		for (const v of opts) {
			const s = String(v ?? '');
			const labelText = (s in labels) ? labels[s] : s;
			if (!labelText) continue;
			const escVal = escapeHtml(s);
			const escLabel = escapeHtml(labelText);
			html += '<option value="' + escVal + '">' + escLabel + '</option>';
		}
		if (!html) {
			html = '<option value="">(select)</option>';
		}
		selectEl.innerHTML = html;
		selectEl.value = selected;
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoPickFirstNonEmpty( arr: any) {
	return _pickFirstNonEmpty(arr);
}

function __kustoToggleSectionModeDropdown( boxId: any, prefix: any, ev: any) {
	try {
		if (ev && typeof ev.stopPropagation === 'function') {
			ev.stopPropagation();
		}
		const menu = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_btn') as any;
		if (!menu || !btn) return;
		const isOpen = menu.style.display !== 'none';
		// Close all other dropdowns first
		try { _closeAllDropdownMenus(); } catch (e) { console.error('[kusto]', e); }
		if (isOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		} else {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoCloseSectionModeDropdown( boxId: any, prefix: any) {
	try {
		const menu = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_' + prefix + '_mode_dropdown_btn') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
}

// Track ResizeObservers for chart/transformation sections
const __kustoSectionModeResizeObservers: any = {};

function __kustoUpdateSectionModeResponsive( boxId: any) {
	try {
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const width = box.offsetWidth || 0;
		const isNarrow = width > 0 && width < 450;
		const isVeryNarrow = width > 0 && width < 250;
		box.classList.toggle('is-section-narrow', isNarrow);
		box.classList.toggle('is-section-very-narrow', isVeryNarrow);
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoSetupSectionModeResizeObserver( boxId: any) {
	try {
		if (__kustoSectionModeResizeObservers[boxId]) return;
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			try { __kustoUpdateSectionModeResponsive(boxId); } catch (e) { console.error('[kusto]', e); }
		});
		observer.observe(box);
		__kustoSectionModeResizeObservers[boxId] = observer;
		__kustoUpdateSectionModeResponsive(boxId);
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoCleanupSectionModeResizeObserver( boxId: any) {
	try {
		const observer = __kustoSectionModeResizeObservers[boxId];
		if (observer && typeof observer.disconnect === 'function') {
			observer.disconnect();
		}
		delete __kustoSectionModeResizeObservers[boxId];
	} catch (e) { console.error('[kusto]', e); }
}

// Close all section-mode dropdowns when clicking outside
try {
	document.addEventListener('click', (ev: any) => {
		try {
			const target = ev.target;
			if (!target) return;
			const inDropdown = target.closest && target.closest('.section-mode-dropdown');
			if (!inDropdown) {
				const menus = document.querySelectorAll('.section-mode-dropdown-menu');
				const btns = document.querySelectorAll('.section-mode-dropdown-btn');
				for (const m of menus as any) {
					try { m.style.display = 'none'; } catch (e) { console.error('[kusto]', e); }
				}
				for (const b of btns) {
					try { b.setAttribute('aria-expanded', 'false'); } catch (e) { console.error('[kusto]', e); }
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	});
} catch (e) { console.error('[kusto]', e); }

export function addPythonBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('python_' + Date.now());
	pythonBoxes.push(id);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-python-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// Pass initial code if available.
	const pendingCode = pState.pendingPythonCodeByBoxId && pState.pendingPythonCodeByBoxId[id];
	if (typeof pendingCode === 'string') {
		litEl.setAttribute('initial-code', pendingCode);
	}

	// Create the light-DOM editor container that Monaco will render into.
	const editorDiv = document.createElement('div');
	editorDiv.className = 'query-editor';
	editorDiv.id = id + '_py_editor';
	editorDiv.slot = 'editor';
	litEl.appendChild(editorDiv);

	// Handle remove event from the Lit component.
	litEl.addEventListener('section-remove', function (e: any) {
		try { removePythonBox(e.detail.boxId); } catch (e) { console.error('[kusto]', e); }
	});

	const afterBoxId = (options && typeof options.afterBoxId === 'string') ? String(options.afterBoxId) : '';
	const afterEl = afterBoxId ? document.getElementById(afterBoxId) : null;
	if (afterEl) {
		afterEl.insertAdjacentElement('afterend', litEl);
	} else {
		container.appendChild(litEl);
	}

	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	if (afterBoxId) {
		try {
			const newEl = document.getElementById(id);
			if (newEl && typeof newEl.scrollIntoView === 'function') {
				newEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	return id;
}

export function removePythonBox( boxId: any) {
	// Legacy editor cleanup (for any old-style boxes still in DOM).
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch (e) { console.error('[kusto]', e); }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoMaximizePythonBox(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor') as any;
	const wrapper = editorEl?.closest?.('.query-editor-wrapper');
	if (!wrapper) return;
	const applyFitToContent = () => {
		try {
			const ed = pythonEditors?.[id];
			if (!ed) return;
			let contentHeight = 0;
			try {
				const ch = typeof ed.getContentHeight === 'function' ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch (e) { console.error('[kusto]', e); }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			let chrome = 0;
			try {
				for (const child of Array.from(wrapper.children || []) as any[]) {
					if (!child || child === editorEl) continue;
					try { if (getComputedStyle(child).display === 'none') continue; } catch (e) { console.error('[kusto]', e); }
					chrome += child.getBoundingClientRect?.().height || 0;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch (e) { console.error('[kusto]', e); }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};

	applyFitToContent();
	setTimeout(applyFitToContent, 50);
	setTimeout(applyFitToContent, 150);
	try { _win.schedulePersist?.(); } catch (e) { console.error('[kusto]', e); }
}

function initPythonEditor( boxId: any) {
	return _win.ensureMonaco().then((monaco: any) => {
		const container = document.getElementById(boxId + '_py_editor') as any;
		if (!container) {
			return;
		}

		// If an editor exists, ensure it's still attached to this container.
		try {
			const existing = pythonEditors && pythonEditors[boxId] ? pythonEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch (e) { console.error('[kusto]', e); }
				try { delete pythonEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = pState.pendingPythonCodeByBoxId && pState.pendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete pState.pendingPythonCodeByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'python',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			scrollbar: { alwaysConsumeMouseWheel: false },
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Mark this as the active Monaco editor for global key handlers (paste, etc.).
		try {
			if (typeof editor.onDidFocusEditorText === 'function') {
				editor.onDidFocusEditorText(() => {
					try { setActiveMonacoEditor(editor); } catch (e) { console.error('[kusto]', e); }
					try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { setActiveMonacoEditor(editor); } catch (e) { console.error('[kusto]', e); }
					try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }

		pythonEditors[boxId] = editor;
		try {
			__kustoEnsureEditorWritableSoon(editor);
		} catch (e) { console.error('[kusto]', e); }
		try {
			__kustoInstallWritableGuard(editor);
		} catch (e) { console.error('[kusto]', e); }
		try {
			container.addEventListener('mousedown', () => {
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
				try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
			}, true);
		} catch (e) { console.error('[kusto]', e); }
		try {
			__kustoAttachAutoResizeToContent(editor, container);
		} catch (e) { console.error('[kusto]', e); }
		try {
			editor.onDidChangeModelContent(() => {
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Enter / Ctrl+Shift+Enter runs the Python code (not the Kusto query).
		try {
			const runPython = () => {
				try {
					const el = document.getElementById(boxId) as any;
					if (el && typeof el._run === 'function') {
						el._run();
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runPython);
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, runPython);
		} catch (e) { console.error('[kusto]', e); }

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer') as any;
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e: any) => {
					try {
						e.preventDefault();
						e.stopPropagation();
					} catch (e) { console.error('[kusto]', e); }
					try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }

					resizer.classList.add('is-dragging');
					const previousCursor = document.body.style.cursor;
					const previousUserSelect = document.body.style.userSelect;
					document.body.style.cursor = 'ns-resize';
					document.body.style.userSelect = 'none';

						const startPageY = e.clientY + getScrollY();
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent: any) => {
							try {
								maybeAutoScrollWhileDragging(moveEvent.clientY);
							} catch (e) { console.error('[kusto]', e); }
							const pageY = moveEvent.clientY + getScrollY();
							const delta = pageY - startPageY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});

				resizer.addEventListener('dblclick', (e: any) => {
					try {
						e.preventDefault();
						e.stopPropagation();
						__kustoMaximizePythonBox(boxId);
					} catch (e) { console.error('[kusto]', e); }
				});
			}
		} catch (e) { console.error('[kusto]', e); }
	}).catch((e: any) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		let attempt = 0;
		try {
			attempt = (__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (python editor).', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			setTimeout(() => {
				try { initPythonEditor(boxId); } catch (e) { console.error('[kusto]', e); }
			}, delay);
		} catch (e) { console.error('[kusto]', e); }
	});
}

function setPythonOutput( boxId: any, text: any) {
	const out = document.getElementById(boxId + '_py_output') as any;
	if (!out) {
		return;
	}
	out.textContent = String(text || '');
}

function runPythonBox( boxId: any) {
	const editor = pythonEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const code = model ? model.getValue() : '';
	setPythonOutput(boxId, 'Running…');
	try {
		postMessageToHost({ type: 'executePython', boxId, code });
	} catch (e: any) {
		setPythonOutput(boxId, 'Failed to send run request.');
	}
}

export function onPythonResult( message: any) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	const stdout = String(message.stdout || '');
	const stderr = String(message.stderr || '');
	const exitCode = (typeof message.exitCode === 'number') ? message.exitCode : null;
	let out = '';
	if (stdout.trim()) {
		out += stdout;
	}
	if (stderr.trim()) {
		if (out) out += '\n\n';
		out += stderr;
	}
	if (!out) {
		out = (exitCode === 0) ? '' : 'No output.';
	}
	setPythonOutput(boxId, out);
}

export function onPythonError( message: any) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

export function addUrlBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('url_' + Date.now());
	urlBoxes.push(id);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-url-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	if (options && typeof options.name === 'string') {
		litEl.setName(options.name);
	}
	if (options && typeof options.url === 'string') {
		litEl.setUrl(options.url);
	}
	if (options && typeof options.expanded === 'boolean') {
		litEl.setExpanded(options.expanded);
	}
	if (options && typeof options.outputHeightPx === 'number') {
		litEl.setAttribute('output-height-px', String(options.outputHeightPx));
	}
	if (options) {
		litEl.setImageDisplayMode(options.imageSizeMode, options.imageAlign, options.imageOverflow);
	}

	litEl.addEventListener('section-remove', function (e: any) {
		try { removeUrlBox(e.detail.boxId); } catch (e) { console.error('[kusto]', e); }
	});

	const afterBoxId = (options && typeof options.afterBoxId === 'string') ? String(options.afterBoxId) : '';
	const afterEl = afterBoxId ? document.getElementById(afterBoxId) : null;
	if (afterEl) {
		afterEl.insertAdjacentElement('afterend', litEl);
	} else {
		container.appendChild(litEl);
	}

	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	if (afterBoxId) {
		try {
			const newEl = document.getElementById(id);
			if (newEl && typeof newEl.scrollIntoView === 'function') {
				newEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	return id;
}

export function removeUrlBox( boxId: any) {
	urlBoxes = urlBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// ── Window bridges for remaining legacy callers ──
window.addPythonBox = addPythonBox;
window.removePythonBox = removePythonBox;
window.addUrlBox = addUrlBox;
window.removeUrlBox = removeUrlBox;
