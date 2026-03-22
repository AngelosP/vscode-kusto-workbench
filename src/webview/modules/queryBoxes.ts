// Query boxes module — converted from legacy/queryBoxes.js
// Window bridge exports at bottom for remaining legacy callers.
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
} from './state';
import './queryBoxes-toolbar';
import { __kustoUpdateQueryResultsToggleButton, __kustoUpdateComparisonSummaryToggleButton, __kustoApplyResultsVisibility, __kustoApplyComparisonSummaryVisibility, setQueryExecuting, __kustoSetLinkedOptimizationMode } from './queryBoxes-execution';
import { indexToAlphaName as __kustoIndexToAlphaName } from '../shared/comparisonUtils';
import { buildSchemaInfo } from '../shared/schema-utils';
import { escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from './utils';
import { syncSelectBackedDropdown } from './dropdown';
import { currentResult, resetCurrentResult } from './resultsState';
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
export {};

const _win = window;

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

export function __kustoPickNextAvailableSectionLetterName( excludeBoxId: any) {
	try {
		const used = __kustoGetUsedSectionNamesUpper(excludeBoxId);
		for (let i = 0; i < 5000; i++) {
			const candidate = __kustoIndexToAlphaName(i).toUpperCase();
			if (!used.has(candidate)) {
				return candidate;
			}
		}
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
	setRunMode(id, 'take100');

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
									const resizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 12;
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
	// Scroll to the bottom only for user-initiated "Add Section".
	// Comparison boxes will be repositioned next to the source and scrolled there instead.
	if (!isComparison) {
		try {
			const controls = document.querySelector('.add-controls');
			if (controls && typeof controls.scrollIntoView === 'function') {
				controls.scrollIntoView({ block: 'end' });
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
			const resizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 12;
			const wrapperBorder = 1;
			const desiredPx = contentH + resizerH + wrapperBorder;
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
					if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
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
// are in queryBoxes-execution.ts.

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
		try { postMessageToHost({ type: 'showInfo', message: 'Schema not loaded yet. Wait for “Schema loaded” then try again.' }); } catch (e) { console.error('[kusto]', e); }
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


// ── Connection/database picker, cluster URL helpers, favorites, missing clusters,
// XML import — absorbed from queryBoxes-connection.ts ──

// ── Connection, favorites & schema management extracted to queryBoxes-connections.ts ──
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
} from './queryBoxes-connections';
// Re-export for other modules that import from './queryBoxes'
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
