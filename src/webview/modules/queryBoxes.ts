// Query boxes module — converted from legacy/queryBoxes.js
// Window bridge exports at bottom for remaining legacy callers.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from './persistence';
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

function __kustoGetClusterUrl( boxId: any) {
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

export function addQueryBox( options: any) {
	const isFirstBox = !(Array.isArray(_win.queryBoxes) && _win.queryBoxes.length > 0);
	const id = (options && options.id) ? String(options.id) : ('query_' + Date.now());
	const initialQuery = (options && options.initialQuery) ? String(options.initialQuery) : '';
	const isComparison = !!(options && options.isComparison);
	const defaultResultsVisible = (options && typeof options.defaultResultsVisible === 'boolean') ? !!options.defaultResultsVisible : true;
	const defaultComparisonSummaryVisible = isComparison ? true : ((options && typeof options.defaultComparisonSummaryVisible === 'boolean') ? !!options.defaultComparisonSummaryVisible : true);
	const defaultExpanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	const afterBoxId = (options && options.afterBoxId) ? String(options.afterBoxId) : '';

	// Insert into queryBoxes array at the right position.
	if (afterBoxId) {
		const afterIdx = _win.queryBoxes.indexOf(afterBoxId);
		if (afterIdx >= 0) {
			_win.queryBoxes.splice(afterIdx + 1, 0, id);
		} else {
			_win.queryBoxes.push(id);
		}
	} else {
		_win.queryBoxes.push(id);
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
			if (typeof toolbar.setCaretDocsActive === 'function') toolbar.setCaretDocsActive(!!_win.caretDocsEnabled);
			if (typeof toolbar.setAutoCompleteActive === 'function') toolbar.setAutoCompleteActive(!!_win.autoTriggerAutocompleteEnabled);
			if (typeof toolbar.setCopilotInlineActive === 'function') toolbar.setCopilotInlineActive(!!_win.copilotInlineCompletionsEnabled);
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
			try { delete _win.schemaByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			try { if (_win.schemaFetchInFlightByBoxId) _win.schemaFetchInFlightByBoxId[boxId] = false; } catch (e) { console.error('[kusto]', e); }
			try { if (_win.lastSchemaRequestAtByBoxId) _win.lastSchemaRequestAtByBoxId[boxId] = 0; } catch (e) { console.error('[kusto]', e); }
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
					const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
					const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
					let clusterKey = '';
					if (clusterUrl) {
						let u = clusterUrl;
						if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
						try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
					}
					const cached = (_win.cachedDatabases && _win.cachedDatabases[clusterKey]) || _win.cachedDatabases[detail.connectionId];
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
				if (typeof _win.favoritesModeByBoxId === 'object') {
					_win.favoritesModeByBoxId[boxId] = !!detail.favoritesMode;
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
						const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '') === prevConnId) : null;
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
						if (typeof window.__kustoClampResultsWrapperHeight === 'function') {
							window.__kustoClampResultsWrapperHeight(id);
						}
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

	// Clamp the query results output wrapper height so it cannot be taller than its contents.
	// This avoids blank slack below short error messages while still allowing the user to
	// resize smaller than contents (scrolling).
	try {
		if (typeof window.__kustoClampResultsWrapperHeight !== 'function') {
			window.__kustoClampResultsWrapperHeight = function (boxId: any) {
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
			};
		}
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
			const ed = (typeof _win.queryEditors === 'object' && _win.queryEditors) ? _win.queryEditors[id] : null;
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
					const ed = (typeof _win.queryEditors === 'object' && _win.queryEditors) ? _win.queryEditors[boxId] : null;
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
	const editor = _win.queryEditors[boxId];
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
	const conn = (_win.connections || []).find((c: any) => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { postMessageToHost({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	const currentSchema = _win.schemaByBoxId ? _win.schemaByBoxId[boxId] : null;
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
						_win.schemaByConnDb[cid + '|' + db] = sch;
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
				const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
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
			const cached = _win.cachedDatabases && _win.cachedDatabases[String(clusterKey || '').trim()];
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
			for (const key of Object.keys(_win.schemaByConnDb || {})) {
				if (!key || !key.startsWith(prefix)) continue;
				const dbName = key.slice(prefix.length);
				if (!dbName) continue;
				list.push({ database: dbName, schema: _win.schemaByConnDb[key] });
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
			for (const c of (_win.connections || [])) {
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
			if (_win.schemaByConnDb && _win.schemaByConnDb[key]) continue;
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
			for (const c of (_win.connections || [])) {
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
				if (_win.schemaByConnDb && _win.schemaByConnDb[key]) continue;
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
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
					try { __kustoSetLinkedOptimizationMode(sourceBoxId, boxId, false); } catch (e) { console.error('[kusto]', e); }
				try { delete _win.optimizationMetadataByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
				try { delete _win.optimizationMetadataByBoxId[sourceBoxId]; } catch (e) { console.error('[kusto]', e); }
			} else if (meta && meta.comparisonBoxId) {
				// If removing the source box, remove the comparison box too.
				const comparisonBoxId = meta.comparisonBoxId;
					try { __kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, false); } catch (e) { console.error('[kusto]', e); }
				try { removeQueryBox(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
				try { delete _win.optimizationMetadataByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Stop any running timer/spinner for this box
	setQueryExecuting(boxId, false);
	delete _win.runModesByBoxId[boxId];
	try {
		if (pState.queryResultJsonByBoxId) {
			delete pState.queryResultJsonByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }

	// Disconnect any resize observer
	if (_win.queryEditorResizeObservers[boxId]) {
		try {
			_win.queryEditorResizeObservers[boxId].disconnect();
		} catch (e) { console.error('[kusto]', e); }
		delete _win.queryEditorResizeObservers[boxId];
	}

	// Disconnect any visibility observers
	try {
		if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers && _win.queryEditorVisibilityObservers[boxId]) {
			try { _win.queryEditorVisibilityObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			delete _win.queryEditorVisibilityObservers[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers && _win.queryEditorVisibilityMutationObservers[boxId]) {
			try { _win.queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			delete _win.queryEditorVisibilityMutationObservers[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }

	// Dispose editor if present
	if (_win.queryEditors[boxId]) {
		try {
			_win.queryEditors[boxId].dispose();
		} catch (e) { console.error('[kusto]', e); }
		delete _win.queryEditors[boxId];
	}

	// Remove from tracked list
	_win.queryBoxes = _win.queryBoxes.filter((id: any) => id !== boxId);
	try { delete _win.lastQueryTextByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	try { delete _win.missingClusterUrlsByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	try {
		if (_win.missingClusterDetectTimersByBoxId && _win.missingClusterDetectTimersByBoxId[boxId]) {
			clearTimeout(_win.missingClusterDetectTimersByBoxId[boxId]);
			delete _win.missingClusterDetectTimersByBoxId[boxId];
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

function computeMissingClusterUrls(detectedClusterUrls: any) {
	return _computeMissing(detectedClusterUrls, _win.connections || []);
}

function renderMissingClustersBanner( boxId: any, missingClusterUrls: any) {
	const banner = document.getElementById(boxId + '_missing_clusters') as any;
	const textEl = document.getElementById(boxId + '_missing_clusters_text') as any;
	if (!banner || !textEl) {
		return;
	}
	const missing = Array.isArray(missingClusterUrls) ? missingClusterUrls : [];
	if (!missing.length) {
		banner.style.display = 'none';
		textEl.innerHTML = '';
		return;
	}
	const shortNames = missing
		.map((u: any) => formatClusterShortName(u))
		.filter(Boolean);
	const label = shortNames.length
		? ('Detected clusters not in your connections: <strong>' + escapeHtml(shortNames.join(', ')) + '</strong>.')
		: 'Detected clusters not in your connections.';
	textEl.innerHTML = label + ' Add them with one click.';
	banner.style.display = 'flex';
}

function updateMissingClustersForBox( boxId: any, queryText: any) {
	try {
		_win.lastQueryTextByBoxId[boxId] = String(queryText || '');
	} catch (e) { console.error('[kusto]', e); }
	try {
		_win.suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
	} catch (e) { console.error('[kusto]', e); }
	const detected = extractClusterUrlsFromQueryText(queryText);
	const missing = computeMissingClusterUrls(detected);
	try { _win.missingClusterUrlsByBoxId[boxId] = missing; } catch (e) { console.error('[kusto]', e); }
	renderMissingClustersBanner(boxId, missing);
}

// Called by Monaco on content changes.
window.__kustoOnQueryValueChanged = function (boxId: any, queryText: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	try { _win.lastQueryTextByBoxId[id] = String(queryText || ''); } catch (e) { console.error('[kusto]', e); }
	try {
		if (_win.missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(_win.missingClusterDetectTimersByBoxId[id]);
		}
		_win.missingClusterDetectTimersByBoxId[id] = setTimeout(() => {
			try { updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || ''); } catch (e) { console.error('[kusto]', e); }
		}, 260);
	} catch (e) { console.error('[kusto]', e); }
};

// Called by main.ts when the connections list changes.
export function __kustoOnConnectionsUpdated() {
	try {
		for (const id of (_win.queryBoxes || [])) {
			updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || '');
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (_win.queryBoxes || [])) {
			try {
				if (_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]) {
					__kustoTryApplyPendingFavoriteSelectionForBox(id);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		__kustoUpdateFavoritesUiForAllBoxes();
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoOnConnectionsUpdated = __kustoOnConnectionsUpdated;

function __kustoFindConnectionIdForClusterUrl( clusterUrl: any) {
	return _findConnIdPure(clusterUrl, _win.connections || []);
}

export function __kustoGetCurrentClusterUrlForBox( boxId: any) {
	return __kustoGetClusterUrl(boxId);
}

export function __kustoGetCurrentDatabaseForBox( boxId: any) {
	return __kustoGetDatabase(boxId);
}

export function __kustoFindFavorite( clusterUrl: any, database: any) {
	return __kustoFindFavorite_pure(clusterUrl, database, Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []);
}

function __kustoGetFavoritesSorted() {
	return __kustoGetFavoritesSorted_pure(Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []);
}

let __kustoAutoEnterFavoritesByBoxId = Object.create(null);
let __kustoAutoEnterFavoritesForNewBoxByBoxId = Object.create(null);

function __kustoMarkNewBoxForFavoritesAutoEnter( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		if (typeof pState.restoreInProgress === 'boolean' && pState.restoreInProgress) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		__kustoAutoEnterFavoritesForNewBoxByBoxId = __kustoAutoEnterFavoritesForNewBoxByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoTryAutoEnterFavoritesModeForNewBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let pending = false;
	try {
		pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]);
	} catch { pending = false; }
	if (!pending) return;
	try {
		if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
			try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;
	const clusterUrl = __kustoGetCurrentClusterUrlForBox(id);
	const db = __kustoGetCurrentDatabaseForBox(id);
	if (!clusterUrl || !db) return;
	const fav = __kustoFindFavorite(clusterUrl, db);
	try {
		if (fav) {
			__kustoApplyFavoritesMode(id, true);
			__kustoUpdateFavoritesUiForBox(id);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
}

window.__kustoSetAutoEnterFavoritesForBox = function (boxId: any, clusterUrl: any, database: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	try {
		__kustoAutoEnterFavoritesByBoxId = __kustoAutoEnterFavoritesByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
	} catch (e) { console.error('[kusto]', e); }
};

function __kustoTryAutoEnterFavoritesModeForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let desired = null;
	try {
		desired = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id]
			? __kustoAutoEnterFavoritesByBoxId[id]
			: null;
	} catch { desired = null; }
	if (!desired) return;
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;
	const fav = __kustoFindFavorite(desired.clusterUrl, desired.database);
	if (!fav) {
		try {
			const isInFavMode = !!(_win.favoritesModeByBoxId && _win.favoritesModeByBoxId[id]);
			if (isInFavMode) {
				__kustoApplyFavoritesMode(id, false);
			}
		} catch (e) { console.error('[kusto]', e); }
		try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
		return;
	}
	try { __kustoApplyFavoritesMode(id, true); } catch (e) { console.error('[kusto]', e); }
	try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
}

export function __kustoTryAutoEnterFavoritesModeForAllBoxes() {
	try {
		for (const id of (_win.queryBoxes || [])) {
			try { __kustoTryAutoEnterFavoritesModeForBox(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoTryAutoEnterFavoritesModeForNewBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoTryAutoEnterFavoritesModeForAllBoxes = __kustoTryAutoEnterFavoritesModeForAllBoxes;

let __kustoDidDefaultFirstBoxToFavorites = false;

export function __kustoMaybeDefaultFirstBoxToFavoritesMode() {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(_win.queryBoxes) || _win.queryBoxes.length !== 1) return;
		const id = String(_win.queryBoxes[0] || '').trim();
		if (!id) return;
		try {
			if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			let desiredCluster = '';
			let desiredDb = '';
			const pending = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id];
			if (pending) {
				desiredCluster = pending.clusterUrl || '';
				desiredDb = pending.database || '';
			}
			if (!desiredCluster) {
				const kwEl = __kustoGetQuerySectionElement(id);
				desiredCluster = kwEl ? __kustoGetClusterUrl(id) : '';
			}
			if (!desiredDb) {
				desiredDb = __kustoGetDatabase(id);
			}
			if (desiredCluster && desiredDb) {
				const fav = __kustoFindFavorite(desiredCluster, desiredDb);
				if (!fav) {
					__kustoDidDefaultFirstBoxToFavorites = true;
					return;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		__kustoApplyFavoritesMode(id, true);
		try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
		__kustoDidDefaultFirstBoxToFavorites = true;
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoMaybeDefaultFirstBoxToFavoritesMode = __kustoMaybeDefaultFirstBoxToFavoritesMode;

let __kustoConfirmRemoveFavoriteCallbacksById = Object.create(null);

window.__kustoOnConfirmRemoveFavoriteResult = function (message: any) {
	try {
		const m = (message && typeof message === 'object') ? message : {};
		const requestId = String(m.requestId || '');
		const ok = !!m.ok;
		if (!requestId) return;
		const cb = __kustoConfirmRemoveFavoriteCallbacksById && __kustoConfirmRemoveFavoriteCallbacksById[requestId];
		try { delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch (e) { console.error('[kusto]', e); }
		if (typeof cb === 'function') {
			try { cb(ok); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
};

window.__kustoGetSelectionOwnerBoxId = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[id];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				return String(meta.sourceBoxId || '').trim() || id;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
};

function __kustoTryApplyPendingFavoriteSelectionForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	let pending = null;
	try {
		pending = _win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]
			? _win.pendingFavoriteSelectionByBoxId[id]
			: null;
	} catch (e) { console.error('[kusto]', e); }
	if (!pending) return false;
	const clusterUrl = String(pending.clusterUrl || '').trim();
	const database = String(pending.database || '').trim();
	if (!clusterUrl || !database) {
		try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
		return false;
	}
	const connectionId = __kustoFindConnectionIdForClusterUrl(clusterUrl);
	if (!connectionId) {
		return false;
	}
	let ownerId = id;
	try {
		ownerId = (typeof window.__kustoGetSelectionOwnerBoxId === 'function')
			? (window.__kustoGetSelectionOwnerBoxId(id) || id)
			: id;
	} catch { ownerId = id; }
	const applyToBox = (targetBoxId: any) => {
		const tid = String(targetBoxId || '').trim();
		if (!tid) return;
		const kwEl = __kustoGetQuerySectionElement(tid);
		if (!kwEl) return;
		try {
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(clusterUrl);
			if (typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(database);
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (connectionId && typeof kwEl.setConnectionId === 'function') {
				kwEl.setConnectionId(connectionId);
			}
			kwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: tid, connectionId: connectionId, clusterUrl: clusterUrl },
				bubbles: true, composed: true,
			}));
		} catch (e) { console.error('[kusto]', e); }
	};
	applyToBox(ownerId);
	if (ownerId !== id) {
		applyToBox(id);
	}
	try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	return true;
}

function __kustoUpdateFavoritesUiForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const kwEl = __kustoGetQuerySectionElement(id);
	if (kwEl && typeof kwEl.setFavorites === 'function') {
		kwEl.setFavorites(Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []);
	}
}

export function __kustoUpdateFavoritesUiForAllBoxes() {
	try {
		_win.queryBoxes.forEach((id: any) =>  {
			try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
		});
	} catch (e) { console.error('[kusto]', e); }
}
window.__kustoUpdateFavoritesUiForAllBoxes = __kustoUpdateFavoritesUiForAllBoxes;

function toggleFavoriteForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const clusterUrl = __kustoGetClusterUrl(id);
	const database = __kustoGetDatabase(id);
	if (!clusterUrl || !database) return;
	const existing = __kustoFindFavorite(clusterUrl, database);
	if (existing) {
		postMessageToHost({ type: 'removeFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	} else {
		postMessageToHost({ type: 'requestAddFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	}
}

function removeFavorite( clusterUrl: any, database: any) {
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	postMessageToHost({ type: 'removeFavorite', clusterUrl: c, database: d });
}

export function closeAllFavoritesDropdowns() {
	// no-op — Lit component handles its own dropdown lifecycle.
}

function __kustoApplyFavoritesMode( boxId: any, enabled: any) {
	_win.favoritesModeByBoxId = _win.favoritesModeByBoxId || {};
	_win.favoritesModeByBoxId[boxId] = !!enabled;
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setFavoritesMode === 'function') {
		kwEl.setFavoritesMode(!!enabled);
	}
}

window.__kustoEnterFavoritesModeForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		__kustoApplyFavoritesMode(id, true);
		__kustoUpdateFavoritesUiForBox(id);
	} catch (e) { console.error('[kusto]', e); }
};

function addMissingClusterConnections( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	const missing = _win.missingClusterUrlsByBoxId[id];
	const clusters = Array.isArray(missing) ? missing.slice() : [];
	if (!clusters.length) {
		return;
	}
	try {
		const hasSelection = !!__kustoGetConnectionId(id);
		const kwEl = __kustoGetQuerySectionElement(id);
		if (kwEl && !hasSelection) {
			const hints = _win.suggestedDatabaseByClusterKeyByBoxId && _win.suggestedDatabaseByClusterKeyByBoxId[id]
				? _win.suggestedDatabaseByClusterKeyByBoxId[id]
				: {};
			let chosenClusterUrl = '';
			let chosenDb = '';
			for (const u of clusters) {
				const key = clusterShortNameKey(u);
				const db = key && hints ? String(hints[key] || '') : '';
				if (db) {
					chosenClusterUrl = String(u || '').trim();
					chosenDb = db;
					break;
				}
			}
			if (!chosenClusterUrl) {
				chosenClusterUrl = String(clusters[0] || '').trim();
				const key0 = clusterShortNameKey(chosenClusterUrl);
				chosenDb = key0 && hints ? String(hints[key0] || '') : '';
			}
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(chosenClusterUrl);
			if (chosenDb && typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(chosenDb);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({
			type: 'addConnectionsForClusters',
			boxId: id,
			clusterUrls: clusters
		});
	} catch (e) { console.error('[kusto]', e); }
}

export function updateConnectionSelects() {
	_win.queryBoxes.forEach((id: any) =>  {
		const el = __kustoGetQuerySectionElement(id);
		if (el && typeof el.setConnections === 'function') {
			el.setConnections(_win.connections || [], { lastConnectionId: _win.lastConnectionId || '' });
		}
		try { __kustoUpdateFavoritesUiForBox(id); } catch (e) { console.error('[kusto]', e); }
	});
	try {
		if (typeof window.__kustoUpdateRunEnabledForAllBoxes === 'function') {
			window.__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function promptAddConnectionFromDropdown( boxId: any) {
	try {
		postMessageToHost({ type: 'promptAddConnection', boxId: boxId });
	} catch (e) { console.error('[kusto]', e); }
}

export function importConnectionsFromXmlFile( boxId: any) {
	try {
		postMessageToHost({ type: 'promptImportConnectionsXml', boxId: boxId });
	} catch (e: any) {
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
	}
}

export function parseKustoExplorerConnectionsXml( xmlText: any) {
	const text = String(xmlText || '');
	if (!text.trim()) {
		return [];
	}
	let doc;
	try {
		doc = new DOMParser().parseFromString(text, 'application/xml');
	} catch {
		return [];
	}
	try {
		const err = doc.getElementsByTagName('parsererror');
		if (err && err.length) {
			return [];
		}
	} catch (e) { console.error('[kusto]', e); }
	const nodes = Array.from(doc.getElementsByTagName('ServerDescriptionBase'));
	const results = [];
	for (const node of nodes) {
		const name = getChildText(node, 'Name');
		const details = getChildText(node, 'Details');
		const connectionString = getChildText(node, 'ConnectionString');
		const parsed = parseKustoConnectionString(connectionString);
		let clusterUrl = (parsed.dataSource || details || '').trim();
		if (!clusterUrl) {
			continue;
		}
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}
		results.push({
			name: (name || '').trim() || clusterUrl,
			clusterUrl: clusterUrl.trim(),
			database: (parsed.initialCatalog || '').trim() || undefined
		});
	}
	const seen = new Set();
	const deduped = [];
	for (const r of results) {
		let key = '';
		try {
			key = (typeof normalizeClusterUrlKey === 'function')
				? normalizeClusterUrlKey(r.clusterUrl || '')
				: String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		} catch {
			key = String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		}
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(r);
	}
	return deduped;
}

function getChildText( node: any, localName: any) {
	if (!node || !node.childNodes) {
		return '';
	}
	for (const child of Array.from(node.childNodes) as any[]) {
		if (!child || child.nodeType !== 1) {
			continue;
		}
		const ln = child.localName || child.nodeName;
		if (String(ln).toLowerCase() === String(localName).toLowerCase()) {
			return String(child.textContent || '');
		}
	}
	return '';
}

function refreshDatabases( boxId: any) {
	const connectionId = __kustoGetConnectionId(boxId);
	if (!connectionId) return;
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setRefreshLoading === 'function') {
		kwEl.setRefreshLoading(true);
		kwEl.setDatabasesLoading(true);
	}
	postMessageToHost({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

export function onDatabasesError( boxId: any, error: any, responseConnectionId: any) {
	const errText = String(error || '');
	const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			if (kwEl && typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(false);
			const refreshBtn = document.getElementById(boxId + '_refresh') as any;
			if (refreshBtn) {
				try {
					if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
						const prev = refreshBtn.dataset.kustoPrevHtml;
						if (typeof prev === 'string' && prev) {
							refreshBtn.innerHTML = prev;
						}
						try { delete refreshBtn.dataset.kustoPrevHtml; } catch (e) { console.error('[kusto]', e); }
						try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch (e) { console.error('[kusto]', e); }
						try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch (e) { console.error('[kusto]', e); }
					}
					refreshBtn.removeAttribute('aria-busy');
					refreshBtn.disabled = false;
				} catch (e) { console.error('[kusto]', e); }
			}
			return;
		}
	}
	try {
		const databaseSelect = document.getElementById(boxId + '_database') as any;
		const refreshBtn = document.getElementById(boxId + '_refresh') as any;
		if (databaseSelect) {
			const hadPreviousContent = databaseSelect.dataset &&
				databaseSelect.dataset.kustoRefreshInFlight === 'true' &&
				typeof databaseSelect.dataset.kustoPrevHtml === 'string' &&
				databaseSelect.dataset.kustoPrevHtml;
			if (isEnotfound) {
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch (e) { console.error('[kusto]', e); }
			} else if (hadPreviousContent) {
				try {
					const prevHtml = databaseSelect.dataset.kustoPrevHtml;
					const prevValue = databaseSelect.dataset.kustoPrevValue;
					if (typeof prevHtml === 'string' && prevHtml) {
						databaseSelect.innerHTML = prevHtml;
					}
					if (typeof prevValue === 'string') {
						databaseSelect.value = prevValue;
					}
				} catch (e) { console.error('[kusto]', e); }
			} else {
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch (e) { console.error('[kusto]', e); }
			}
			databaseSelect.disabled = false;
			try { syncSelectBackedDropdown(boxId + '_database'); } catch (e) { console.error('[kusto]', e); }
			try {
				if (databaseSelect.dataset) {
					delete databaseSelect.dataset.kustoRefreshInFlight;
					delete databaseSelect.dataset.kustoPrevHtml;
					delete databaseSelect.dataset.kustoPrevValue;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (refreshBtn) {
			try {
				if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
					const prev = refreshBtn.dataset.kustoPrevHtml;
					if (typeof prev === 'string' && prev) {
						refreshBtn.innerHTML = prev;
					}
					try { delete refreshBtn.dataset.kustoPrevHtml; } catch (e) { console.error('[kusto]', e); }
					try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch (e) { console.error('[kusto]', e); }
					try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch (e) { console.error('[kusto]', e); }
				}
				refreshBtn.removeAttribute('aria-busy');
			} catch (e) { console.error('[kusto]', e); }
			refreshBtn.disabled = false;
		}
	} catch (e) { console.error('[kusto]', e); }
	// Reset Lit component loading states so spinners don't get stuck on error.
	try {
		if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
		if (kwEl && typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(false);
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function updateDatabaseSelect( boxId: any, databases: any, responseConnectionId: any) {
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			return;
		}
	}
	const list = (Array.isArray(databases) ? databases : [])
		.map((d: any) => String(d || '').trim())
		.filter(Boolean)
		.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const connectionId = __kustoGetConnectionId(boxId);
	if (connectionId) {
		let clusterKey = '';
		try {
			const cid = String(connectionId || '').trim();
			const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
			const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
			if (clusterUrl) {
				let u = clusterUrl;
				if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
				try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
			}
		} catch (e) { console.error('[kusto]', e); }
		_win.cachedDatabases[String(clusterKey || '').trim()] = list;
	}
	if (kwEl && typeof kwEl.setDatabases === 'function') {
		kwEl.setDatabases(list, _win.lastDatabase || '');
		kwEl.setRefreshLoading(false);
	}
	try { __kustoTryAutoEnterFavoritesModeForNewBox(boxId); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Schema functions (relocated from schema.ts) ──

export function ensureSchemaForBox(boxId: string, forceRefresh?: boolean): void {
	if (!boxId) {
		return;
	}
	if (!forceRefresh && _win.schemaByBoxId[boxId]) {
		return;
	}
	if (_win.schemaFetchInFlightByBoxId[boxId]) {
		return;
	}
	const now = Date.now();
	const last = _win.lastSchemaRequestAtByBoxId[boxId] || 0;
	// Avoid spamming schema fetch requests if autocomplete is invoked repeatedly.
	if (!forceRefresh && now - last < 1500) {
		return;
	}
	_win.lastSchemaRequestAtByBoxId[boxId] = now;

	let ownerId = boxId;
	try {
		if (typeof (_win.__kustoGetSelectionOwnerBoxId) === 'function') {
			ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
		}
	} catch (e) { console.error('[kusto]', e); }
	const connectionId = __kustoGetConnectionId(ownerId);
	const database = __kustoGetDatabase(ownerId);
	if (!connectionId || !database) {
		return;
	}

	// Set loading state.
	_win.schemaFetchInFlightByBoxId[boxId] = true;
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Loading\u2026' });
		}
	} catch (e) { console.error('[kusto]', e); }

	let requestToken = '';
	try {
		requestToken = 'schema_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		schemaRequestTokenByBoxId[boxId] = requestToken;
	} catch (e) { console.error('[kusto]', e); }
	postMessageToHost({
		type: 'prefetchSchema',
		connectionId,
		database,
		boxId,
		forceRefresh: !!forceRefresh,
		requestToken
	});
}

function onDatabaseChanged(boxId: string): void {
	// Clear any prior schema so it matches the newly selected DB.
	delete _win.schemaByBoxId[boxId];
	// Clear request throttling/in-flight so we can fetch immediately for the new DB.
	try {
		if (_win.schemaFetchInFlightByBoxId) {
			_win.schemaFetchInFlightByBoxId[boxId] = false;
		}
		if (_win.lastSchemaRequestAtByBoxId) {
			_win.lastSchemaRequestAtByBoxId[boxId] = 0;
		}
		if (schemaRequestTokenByBoxId) {
			delete schemaRequestTokenByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
	// Reset schema UI.
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo(buildSchemaInfo('', false));
		}
	} catch (e) { console.error('[kusto]', e); }
	// Persist selection immediately so VS Code Problems can reflect current schema context.
	try {
		if (!pState.restoreInProgress) {
			const connectionId = __kustoGetConnectionId(boxId);
			const database = __kustoGetDatabase(boxId);
			postMessageToHost({
				type: 'saveLastSelection',
				connectionId: String(connectionId || ''),
				database: String(database || '')
			});
		}
	} catch (e) { console.error('[kusto]', e); }
	ensureSchemaForBox(boxId, false);
	// Update monaco-kusto schema if we have a cached schema for the new database
	try {
		if (typeof (_win.__kustoUpdateSchemaForFocusedBox) === 'function') {
			_win.__kustoUpdateSchemaForFocusedBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateFavoritesUiForBox) === 'function') {
			_win.__kustoUpdateFavoritesUiForBox(boxId);
		} else if (typeof (_win.__kustoUpdateFavoritesUiForAllBoxes) === 'function') {
			_win.__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof (_win.__kustoUpdateRunEnabledForBox) === 'function') {
			_win.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { if (typeof (_win.schedulePersist) === 'function') _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function refreshSchema(boxId: string): void {
	if (!boxId) {
		return;
	}

	// Update schema info UI via Lit element.
	try {
		const kwEl = __kustoGetQuerySectionElement(boxId);
		if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
			kwEl.setSchemaInfo({ status: 'loading', statusText: 'Refreshing\u2026' });
		}
	} catch (e) { console.error('[kusto]', e); }

	_win.lastSchemaRequestAtByBoxId[boxId] = 0;
	ensureSchemaForBox(boxId, true);
}

// Request schema for an arbitrary (connectionId, database) pair.
async function __kustoRequestSchema(connectionId: string, database: string, forceRefresh?: boolean): Promise<any> {
	try {
		const cid = String(connectionId || '').trim();
		const db = String(database || '').trim();
		if (!cid || !db) {
			return null;
		}
		const key = cid + '|' + db;
		try {
			const schemaByConnDb = _win.schemaByConnDb as any;
			if (!forceRefresh && schemaByConnDb && schemaByConnDb[key]) {
				return schemaByConnDb[key];
			}
		} catch (e) { console.error('[kusto]', e); }

		const reqBoxId = '__schema_req__' + Date.now() + '_' + Math.random().toString(16).slice(2);
		const p = new Promise((resolve, reject) => {
			try {
				_win.schemaRequestResolversByBoxId[reqBoxId] = { resolve, reject, key };
			} catch (e) {
				reject(e);
			}
		});
		try {
			postMessageToHost({
				type: 'prefetchSchema',
				connectionId: cid,
				database: db,
				boxId: reqBoxId,
				forceRefresh: !!forceRefresh
			});
		} catch (e) {
			try { delete _win.schemaRequestResolversByBoxId[reqBoxId]; } catch (e) { console.error('[kusto]', e); }
			throw e;
		}
		return await p;
	} catch {
		return null;
	}
}

// Request database list for an arbitrary connectionId.
async function __kustoRequestDatabases(connectionId: string, forceRefresh?: boolean): Promise<any[]> {
	const cid = String(connectionId || '').trim();
	if (!cid) {
		return [];
	}
	try {
		let clusterKey = '';
		try {
			const conn = Array.isArray(_win.connections) ? (_win.connections as any[]).find((c: any) => c && String(c.id || '').trim() === cid) : null;
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

		const cachedDatabases = _win.cachedDatabases as any;
		const cachedByCluster = cachedDatabases && cachedDatabases[String(clusterKey || '').trim()];
		if (!forceRefresh && Array.isArray(cachedByCluster) && cachedByCluster.length) {
			return cachedByCluster;
		}

		// Legacy fallback (pre per-cluster cache): allow reading by connectionId.
		const cachedByConnectionId = cachedDatabases && cachedDatabases[cid];
		if (!forceRefresh && Array.isArray(cachedByConnectionId) && cachedByConnectionId.length) {
			return cachedByConnectionId;
		}
	} catch (e) { console.error('[kusto]', e); }

	const requestId = '__kusto_dbreq__' + encodeURIComponent(cid) + '__' + Date.now() + '_' + Math.random().toString(16).slice(2);
	return await new Promise((resolve, reject) => {
		try {
			let resolvers = _win.databasesRequestResolversByBoxId as any;
			if (!resolvers || typeof resolvers !== 'object') {
				resolvers = {};
				_win.databasesRequestResolversByBoxId = resolvers;
			}
			resolvers[requestId] = { resolve, reject };
		} catch {
			resolve([]);
			return;
		}

		try {
			postMessageToHost({
				type: forceRefresh ? 'refreshDatabases' : 'getDatabases',
				connectionId: cid,
				boxId: requestId
			});
		} catch (e) {
			try { delete _win.databasesRequestResolversByBoxId[requestId]; } catch (e) { console.error('[kusto]', e); }
			reject(e);
		}
	});
};

// ── Window bridges for remaining legacy callers ──
// Execution, comparison, and optimization bridges are in queryBoxes-execution.ts.
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
