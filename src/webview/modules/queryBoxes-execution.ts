// Query execution, result handling, comparison, optimization — extracted from queryBoxes.ts
// Window bridge exports at bottom for remaining legacy callers.
import { postMessageToHost } from '../shared/webview-messages';
import {
	normalizeCellForComparison as __kustoNormalizeCellForComparison,
	rowKeyForComparison as __kustoRowKeyForComparison,
	normalizeColumnNameForComparison as __kustoNormalizeColumnNameForComparison,
	getNormalizedColumnNameList as __kustoGetNormalizedColumnNameList,
	doColumnHeaderNamesMatch as __kustoDoColumnHeaderNamesMatch,
	getColumnDifferences as __kustoGetColumnDifferences,
	doColumnOrderMatch as __kustoDoColumnOrderMatch,
	doRowOrderMatch as __kustoDoRowOrderMatch,
	buildColumnIndexMapForNames as __kustoBuildColumnIndexMapForNames,
	buildNameBasedColumnMapping as __kustoBuildNameBasedColumnMapping,
	rowKeyForComparisonWithColumnMapping as __kustoRowKeyForComparisonWithColumnMapping,
	rowKeyForComparisonIgnoringColumnOrder as __kustoRowKeyForComparisonIgnoringColumnOrder,
	areResultsEquivalentWithDetails as __kustoAreResultsEquivalentWithDetails,
	areResultsEquivalent as __kustoAreResultsEquivalent,
	doResultHeadersMatch as __kustoDoResultHeadersMatch,
	formatElapsed,
	isValidConnectionIdForRun as __kustoIsValidConnectionIdForRun_pure,
} from '../shared/comparisonUtils';
import { escapeHtml } from './utils';
import { pState } from '../shared/persistence-state';
import { schedulePersist } from './persistence';
import {
__kustoGetConnectionId, __kustoGetDatabase, __kustoGetQuerySectionElement,
__kustoSetSectionName, __kustoGetSectionName, __kustoPickNextAvailableSectionLetterName,
addQueryBox, toggleCacheControls, removeQueryBox,
__kustoGetCurrentClusterUrlForBox, __kustoGetCurrentDatabaseForBox, __kustoFindFavorite,
__kustoLog
} from './queryBoxes';
import { getRunModeLabelText } from '../shared/comparisonUtils';
import { getRunMode, setRunMode, closeRunMenu } from './queryBoxes-toolbar';
import { getResultsState, ensureResultsStateMap } from './resultsState';
import {
	optimizationMetadataByBoxId, queryEditors, pendingFavoriteSelectionByBoxId,
	queryExecutionTimers, schemaByBoxId, queryBoxes,
} from './state';
export {};

export const lastRunCacheEnabledByBoxId: Record<string, boolean> = {};

const _win = window;

export function __kustoSetResultsVisible( boxId: any, visible: any) {
	try {
		pState.resultsVisibleByBoxId[boxId] = !!visible;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
}

function __kustoLockCacheForBenchmark( boxId: any) {
	const msg = 'When doing performance benchmarks we cannot use caching.';
	try {
		const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
		const valueInput = document.getElementById(boxId + '_cache_value') as any;
		const unitSelect = document.getElementById(boxId + '_cache_unit') as any;
		if (checkbox) {
			checkbox.checked = false;
			checkbox.disabled = true;
			checkbox.title = msg;
			try {
				const label = checkbox.closest('label');
				if (label) {
					label.title = msg;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (valueInput) {
			valueInput.disabled = true;
			valueInput.title = msg;
		}
		if (unitSelect) {
			unitSelect.disabled = true;
			unitSelect.title = msg;
		}
		try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
		try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// Pure comparison functions moved to ../shared/comparisonUtils.ts
// They are imported at the top of this file and re-exported via window bridges at the bottom.

function __kustoUpdateAcceptOptimizationsButton( comparisonBoxId: any, enabled: any, tooltip: any) {
	const btn = document.getElementById(comparisonBoxId + '_accept_btn') as any;
	if (!btn) {
		return;
	}
	btn.disabled = !enabled;
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled when the optimized query has results.');
	btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

export function acceptOptimizations( comparisonBoxId: any) {
	try {
		const meta = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) ? optimizationMetadataByBoxId[comparisonBoxId] : null;
		const sourceBoxId = meta && meta.sourceBoxId ? meta.sourceBoxId : '';
		const optimizedQuery = meta && typeof meta.optimizedQuery === 'string' ? meta.optimizedQuery : '';
		if (!sourceBoxId || !optimizedQuery) {
			return;
		}
		if (queryEditors[sourceBoxId] && typeof queryEditors[sourceBoxId].setValue === 'function') {
			queryEditors[sourceBoxId].setValue(optimizedQuery);
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		}
		try { __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, false); } catch (e) { console.error('[kusto]', e); }
		// Remove comparison box and clear metadata links.
		try { removeQueryBox(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
				delete optimizationMetadataByBoxId[comparisonBoxId];
				if (optimizationMetadataByBoxId[sourceBoxId]) {
					delete optimizationMetadataByBoxId[sourceBoxId];
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		try { postMessageToHost({ type: 'showInfo', message: 'Optimizations accepted: source query updated.' }); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoUpdateQueryResultsToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_results_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false);
	} catch (e) { console.error('[kusto]', e); }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide results' : 'Show results';
	btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
}

export function __kustoUpdateComparisonSummaryToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_summary_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch (e) { console.error('[kusto]', e); }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide comparison summary' : 'Show comparison summary';
	btn.setAttribute('aria-label', visible ? 'Hide comparison summary' : 'Show comparison summary');
}

export function __kustoApplyResultsVisibility( boxId: any) {
	const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
	if (!wrapper) {
		// Support non-query-box results (e.g. URL CSV preview) that render a results block
		// without the surrounding *_results_wrapper.
		let visible = true;
		try {
			visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false);
		} catch (e) { console.error('[kusto]', e); }
		try {
			const body = document.getElementById(boxId + '_results_body') as any;
			if (body) {
				body.style.display = visible ? '' : 'none';
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv && resultsDiv.classList) {
				resultsDiv.classList.toggle('is-results-hidden', !visible);
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	let visible = true;
	try {
		visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false);
	} catch (e) { console.error('[kusto]', e); }
	// Only show wrapper when there's content.
	const resultsDiv = document.getElementById(boxId + '_results') as any;
	const hasContent = !!(resultsDiv && String(resultsDiv.innerHTML || '').trim());
	let hasTable = false;
	try {
		hasTable = !!(resultsDiv && resultsDiv.querySelector && (resultsDiv.querySelector('.table-container') || resultsDiv.querySelector('kw-data-table')));
	} catch (e) { console.error('[kusto]', e); }

	// <kw-data-table> manages its own show/hide internally.
	// Respect the persisted visibility state; don't unconditionally show everything.
	if (resultsDiv && resultsDiv.querySelector && resultsDiv.querySelector('kw-data-table')) {
		wrapper.style.display = 'flex';
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		let visible = true;
		try {
			visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false);
		} catch (e) { console.error('[kusto]', e); }
		if (!visible) {
			// Collapsed: header-only height, hide resizer.
			// Preserve the current height so toggling results back on restores it.
			const curH = wrapper.style.height;
			if (curH && curH !== 'auto' && curH !== '40px') {
				try { wrapper.dataset.kustoPreviousHeight = curH; } catch (e) { console.error('[kusto]', e); }
			}
			wrapper.style.height = '40px';
			wrapper.style.overflow = 'hidden';
			if (resizer) resizer.style.display = 'none';
		} else {
			if (resizer) resizer.style.display = '';
			// Restore previous height if available.
			const prev = wrapper.dataset?.kustoPreviousHeight;
			if (prev) {
				wrapper.style.height = prev;
				wrapper.style.overflow = '';
				try { delete wrapper.dataset.kustoPreviousHeight; } catch (e) { console.error('[kusto]', e); }
			} else if (!wrapper.style.height || wrapper.style.height === 'auto') {
				wrapper.style.height = '300px';
			}
		}
		return;
	}

	wrapper.style.display = hasContent ? 'flex' : 'none';
	if (hasContent) {
		const body = document.getElementById(boxId + '_results_body') as any;
		if (body) {
			body.style.display = visible ? '' : 'none';
		}
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		if (resizer) {
			// Cleaner UI: only show the resize handle when a successful results table is rendered.
			resizer.style.display = (visible && hasTable) ? '' : 'none';
		}
		try {
			if (!visible) {
				// Collapse to just the header (minimum height needed).
				if (wrapper.style.height && wrapper.style.height !== 'auto') {
					wrapper.dataset.kustoPreviousHeight = wrapper.style.height;
				}
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else if (!hasTable) {
				// Error-only (or non-table) content: hug content and hide resizer.
				try {
					if (wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPrevSuccessHeight = wrapper.style.height;
					}
				} catch (e) { console.error('[kusto]', e); }
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else {
				// Successful results table: allow resizing.
				wrapper.style.minHeight = '120px';
				if (!wrapper.style.height || wrapper.style.height === 'auto') {
					if (wrapper.dataset.kustoPreviousHeight) {
						wrapper.style.height = wrapper.dataset.kustoPreviousHeight;
					} else if (wrapper.dataset.kustoPrevSuccessHeight) {
						wrapper.style.height = wrapper.dataset.kustoPrevSuccessHeight;
					} else {
						wrapper.style.height = '240px';
					}
				}
				// Guardrail: never allow the wrapper to become so tall that the table can't scroll.
				// A huge persisted/previous height makes the container as tall as the full table,
				// which removes the scrollbar and kills virtualization performance.
				try {
					const m = String(wrapper.style.height || '').trim().match(/^([0-9]+)px$/i);
					if (m) {
						const px = parseInt(m[1], 10);
						if (isFinite(px)) {
							const clamped = Math.max(120, Math.min(900, px));
							if (clamped !== px) {
								wrapper.style.height = clamped + 'px';
							}
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function __kustoApplyComparisonSummaryVisibility( boxId: any) {
	const box = document.getElementById(boxId) as any;
	if (!box) {
		return;
	}
	const banner = box.querySelector('.comparison-summary-banner');
	if (!banner) {
		return;
	}
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) {
			banner.style.display = '';
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch (e) { console.error('[kusto]', e); }
	banner.style.display = visible ? '' : 'none';
}

function toggleQueryResultsVisibility( boxId: any) {
	try {
		if (!pState.resultsVisibleByBoxId || typeof pState.resultsVisibleByBoxId !== 'object') {
			pState.resultsVisibleByBoxId = {};
		}
		const current = !(pState.resultsVisibleByBoxId[boxId] === false);
		pState.resultsVisibleByBoxId[boxId] = !current;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoOnResultsVisibilityToggled === 'function') {
			window.__kustoOnResultsVisibilityToggled(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function toggleComparisonSummaryVisibility( boxId: any) {
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) {
			// Optimized sections always show summary.
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		const current = !(window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
		window.__kustoComparisonSummaryVisibleByBoxId[boxId] = !current;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateComparisonSummaryToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyComparisonSummaryVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoEnsureCacheBackupMap() {
	if (!window.__kustoCacheBackupByBoxId || typeof window.__kustoCacheBackupByBoxId !== 'object') {
		window.__kustoCacheBackupByBoxId = {};
	}
	return window.__kustoCacheBackupByBoxId;
}

function __kustoBackupCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	if (map[boxId]) {
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		map[boxId] = {
			enabled: enabledEl ? !!enabledEl.checked : true,
			value: valueEl ? (parseInt(valueEl.value) || 1) : 1,
			unit: unitEl ? String(unitEl.value || 'days') : 'days'
		};
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoRestoreCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	const backup = map[boxId];
	if (!backup) {
		// Ensure controls are re-enabled if we had disabled them.
		try {
			const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
			const valueEl = document.getElementById(boxId + '_cache_value') as any;
			const unitEl = document.getElementById(boxId + '_cache_unit') as any;
			if (enabledEl) { enabledEl.disabled = false; enabledEl.title = ''; }
			if (valueEl) { valueEl.disabled = false; valueEl.title = ''; }
			if (unitEl) { unitEl.disabled = false; unitEl.title = ''; }
			try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		if (enabledEl) {
			enabledEl.checked = !!backup.enabled;
			enabledEl.disabled = false;
			enabledEl.title = '';
			try {
				const label = enabledEl.closest('label');
				if (label) { label.title = ''; }
			} catch (e) { console.error('[kusto]', e); }
		}
		if (valueEl) {
			valueEl.value = String(backup.value || 1);
			valueEl.disabled = false;
			valueEl.title = '';
		}
		if (unitEl) {
			unitEl.value = String(backup.unit || 'days');
			unitEl.disabled = false;
			unitEl.title = '';
		}
		try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
	try { delete map[boxId]; } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoEnsureRunModeBackupMap() {
	if (!window.__kustoRunModeBackupByBoxId || typeof window.__kustoRunModeBackupByBoxId !== 'object') {
		window.__kustoRunModeBackupByBoxId = {};
	}
	return window.__kustoRunModeBackupByBoxId;
}

function __kustoBackupRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	// Only back up once per optimization session.
	if (map[boxId] && typeof map[boxId].mode === 'string') {
		return;
	}
	try {
		map[boxId] = { mode: String(getRunMode(boxId) || 'take100') };
	} catch {
		map[boxId] = { mode: 'take100' };
	}
}

function __kustoRestoreRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	const backup = map[boxId];
	if (!backup || typeof backup.mode !== 'string') {
		return;
	}
	try {
		setRunMode(boxId, String(backup.mode || 'take100'));
	} catch (e) { console.error('[kusto]', e); }
	try { delete map[boxId]; } catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetLinkedOptimizationMode( sourceBoxId: any, comparisonBoxId: any, active: any) {
	const ids = [String(sourceBoxId || '').trim(), String(comparisonBoxId || '').trim()].filter(Boolean);
	for (const id of ids) {
		const el = document.getElementById(id) as any;
		if (!el) continue;
		if (active) {
			try { __kustoBackupCacheSettings(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoBackupRunMode(id); } catch (e) { console.error('[kusto]', e); }
			try { setRunMode(id, 'plain'); } catch (e) { console.error('[kusto]', e); }
			el.classList.add('has-linked-optimization');
		} else {
			el.classList.remove('has-linked-optimization');
			try { __kustoRestoreCacheSettings(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoRestoreRunMode(id); } catch (e) { console.error('[kusto]', e); }
		}
	}
}

// Toggle buttons, toolbar actions, share modal, toolbar overflow, tools dropdown,
// run modes, and global dropdown dismiss handlers are in queryBoxes-toolbar.ts.

export function displayComparisonSummary( sourceBoxId: any, comparisonBoxId: any) {
	const sourceState = getResultsState(sourceBoxId);
	const comparisonState = getResultsState(comparisonBoxId);
	
	if (!sourceState || !comparisonState) {
		return;
	}

	const getBoxLabel = (boxId: any) => {
		try {
			const name = __kustoGetSectionName(boxId);
			return name || String(boxId || '').trim() || 'Dataset';
		} catch {
			return String(boxId || '').trim() || 'Dataset';
		}
	};
	const sourceLabel = getBoxLabel(sourceBoxId);
	const comparisonLabel = getBoxLabel(comparisonBoxId);
	const pluralRows = (n: any) => (Number(n) === 1 ? 'row' : 'rows');
	
	const sourceRows = sourceState.rows ? sourceState.rows.length : 0;
	const comparisonRows = comparisonState.rows ? comparisonState.rows.length : 0;
	const sourceCols = sourceState.columns ? sourceState.columns.length : 0;
	const comparisonCols = comparisonState.columns ? comparisonState.columns.length : 0;
	
	// Extract execution times
	const sourceExecTime = sourceState.metadata && sourceState.metadata.executionTime || '';
	const comparisonExecTime = comparisonState.metadata && comparisonState.metadata.executionTime || '';
	
	// Parse execution times (e.g., "123ms" or "1.23s")
	const parseExecTime = (timeStr: any) => {
		if (!timeStr) return null;
		const match = timeStr.match(/([\d.]+)\s*(ms|s)/);
		if (!match) return null;
		const value = parseFloat(match[1]);
		const unit = match[2];
		return unit === 's' ? value * 1000 : value; // Convert to ms
	};
	
	const sourceMs = parseExecTime(sourceExecTime);
	const comparisonMs = parseExecTime(comparisonExecTime);
	
	let perfMessage = '';
	if (sourceMs !== null && comparisonMs !== null && sourceMs > 0) {
		const diff = sourceMs - comparisonMs;
		const percentChange = ((diff / sourceMs) * 100).toFixed(1);
		if (diff > 0) {
			perfMessage = `<span style="color: #89d185;">\u2713 ${percentChange}% faster (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else if (diff < 0) {
			perfMessage = `<span style="color: #f48771;">\u26a0 ${Math.abs(Number(percentChange))}% slower (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else {
			perfMessage = `<span style="color: #cccccc;">\u2248 Same performance (${sourceExecTime})</span>`;
		}
	} else if (sourceExecTime && comparisonExecTime) {
		perfMessage = `<span style="color: #cccccc;">${sourceExecTime} \u2192 ${comparisonExecTime}</span>`;
	}

	// ─── Server-side statistics comparison ───
	const sourceStats = (sourceState.metadata && sourceState.metadata.serverStats) || null;
	const comparisonStats = (comparisonState.metadata && comparisonState.metadata.serverStats) || null;

	// Helper: format a delta metric line.
	// sourceVal/comparisonVal are numbers (or null/undefined to skip).
	// options: { emoji, label, formatter, lowerIsBetter (default true), unit (for raw fallback) }
	const formatDelta = (sourceVal: any, comparisonVal: any, opts: any) => {
		const emoji = opts.emoji || '';
		const label = opts.label || '';
		const fmt = opts.formatter || ((v: any) => String(v));
		const lowerIsBetter = opts.lowerIsBetter !== false;

		// eslint-disable-next-line eqeqeq
		if (sourceVal == null || comparisonVal == null || !isFinite(sourceVal) || !isFinite(comparisonVal)) {
			return null; // not available
		}

		const sFormatted = fmt(sourceVal);
		const cFormatted = fmt(comparisonVal);

		if (sourceVal === 0 && comparisonVal === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const diff = sourceVal - comparisonVal;
		if (diff === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const base = sourceVal !== 0 ? sourceVal : 1;
		const pct = Math.abs((diff / base) * 100).toFixed(1);
		// "improved" means lower-is-better and value went down, or higher-is-better and value went up.
		const improved = lowerIsBetter ? (diff > 0) : (diff < 0);
		const verb = lowerIsBetter ? (improved ? 'less' : 'more') : (improved ? 'more' : 'less');
		const color = improved ? '#89d185' : '#f48771';
		const icon = improved ? '\u2713' : '\u26a0';

		return `<div class="comparison-metric">${emoji} ${label}: <span style="color: ${color};">${icon} ${pct}% ${verb} (${sFormatted} \u2192 ${cFormatted})</span></div>`;
	};

	// Formatters
	const fmtCpuMs = (ms: any) => {
		if (ms < 1000) { return ms.toFixed(1) + 'ms'; }
		return (ms / 1000).toFixed(3) + 's';
	};
	const fmtBytes = (bytes: any) => {
		// eslint-disable-next-line eqeqeq
		if (bytes == null || !isFinite(bytes)) { return '?'; }
		if (bytes < 1024) { return bytes + ' B'; }
		if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
		if (bytes < 1024 * 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
		return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
	};
	const fmtNum = (n: any) => {
		// eslint-disable-next-line eqeqeq
		if (n == null) { return '?'; }
		return Number(n).toLocaleString();
	};

	// Build per-metric lines (only shown when server stats are available for both)
	let cpuMessage = null;
	let memoryMessage = null;
	let extentsMessage = null;
	let cacheMessage = null;

	if (sourceStats && comparisonStats) {
		cpuMessage = formatDelta(sourceStats.cpuTimeMs, comparisonStats.cpuTimeMs, {
			emoji: '\uD83D\uDDA5\uFE0F', label: 'Server CPU', formatter: fmtCpuMs, lowerIsBetter: true
		});
		memoryMessage = formatDelta(sourceStats.peakMemoryPerNode, comparisonStats.peakMemoryPerNode, {
			emoji: '\uD83D\uDCBE', label: 'Peak memory', formatter: fmtBytes, lowerIsBetter: true
		});
		extentsMessage = formatDelta(sourceStats.extentsScanned, comparisonStats.extentsScanned, {
			emoji: '\uD83D\uDCCA', label: 'Extents scanned', formatter: fmtNum, lowerIsBetter: true
		});

		// Cache hit rate: compute as percentage hits/(hits+misses), compare the rates.
		const cacheRate = (stats: any) => {
			const mh = typeof stats.memoryCacheHits === 'number' ? stats.memoryCacheHits : 0;
			const mm = typeof stats.memoryCacheMisses === 'number' ? stats.memoryCacheMisses : 0;
			const dh = typeof stats.diskCacheHits === 'number' ? stats.diskCacheHits : 0;
			const dm = typeof stats.diskCacheMisses === 'number' ? stats.diskCacheMisses : 0;
			const hits = mh + dh;
			const total = hits + mm + dm;
			return total > 0 ? (hits / total) * 100 : null;
		};
		const sourceRate = cacheRate(sourceStats);
		const comparisonRate = cacheRate(comparisonStats);
		const fmtRate = (r: any) => r.toFixed(1) + '%';
		cacheMessage = formatDelta(sourceRate, comparisonRate, {
			emoji: '\uD83C\uDFAF', label: 'Cache hit rate', formatter: fmtRate, lowerIsBetter: false
		});
	}
	
	// Check data consistency.
	// Data matches if:
	// 1. Same columns (names match, order doesn't matter)
	// 2. Same rows (no unmatched rows in either dataset, order doesn't matter)
	const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
	
	let rowsMatch = false;
	let commonCount = 0;
	let onlyACount = 0;
	let onlyBCount = 0;
	let countsLabel = '';
	try {
		const dv = (window && window.__kustoDiffView) ? window.__kustoDiffView : null;
		if (dv && typeof dv.buildModelFromResultsStates === 'function') {
			const model = dv.buildModelFromResultsStates(sourceState, comparisonState, { aLabel: sourceLabel, bLabel: comparisonLabel });
			const p = (model && model.partitions && typeof model.partitions === 'object') ? model.partitions : null;
			commonCount = Array.isArray(p && p.common) ? p.common.length : 0;
			onlyACount = Array.isArray(p && p.onlyA) ? p.onlyA.length : 0;
			onlyBCount = Array.isArray(p && p.onlyB) ? p.onlyB.length : 0;
			countsLabel =
				' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + escapeHtml(comparisonLabel) +
				')';
			rowsMatch = (onlyACount === 0 && onlyBCount === 0);
		}
	} catch (e) { console.error('[kusto]', e); }

	// Data matches only if both columns AND rows match.
	const dataMatches = columnHeaderNamesMatch && rowsMatch;

	// Additional metadata for warnings (order differences don't affect data matching).
	const rowOrderMatches = __kustoDoRowOrderMatch(sourceState, comparisonState);
	const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);
	const warningNeeded = dataMatches && !(rowOrderMatches && columnOrderMatches);

	const yesNo = (v: any) => (v ? 'yes' : 'no');
	const warningTitle =
		'Order of rows matches: ' + yesNo(rowOrderMatches) + '\n' +
		'Order of columns matches: ' + yesNo(columnOrderMatches) + '\n' +
		'Names of column headers match: ' + yesNo(columnHeaderNamesMatch);

	let dataMessage = '';
	if (dataMatches) {
		dataMessage =
			'<span class="comparison-data-match">\u2713 Data matches</span>' +
			(warningNeeded
				? '<span class="comparison-warning-icon" title="' + warningTitle.replace(/"/g, '&quot;') + '">\u26a0</span>'
				: '');
	} else {
		// Determine if the difference is in columns, rows, or both.
		const columnDiff = __kustoGetColumnDifferences(sourceState, comparisonState);
		const hasColumnDiff = columnDiff.onlyInA.length > 0 || columnDiff.onlyInB.length > 0;
		const hasRowDiff = onlyACount > 0 || onlyBCount > 0;

		let diffLabel = '';
		let diffTitle = 'View diff';
		if (hasColumnDiff && !hasRowDiff) {
			// Only column differences
			const parts = [];
			if (columnDiff.onlyInA.length > 0) {
				parts.push(String(columnDiff.onlyInA.length) + ' missing ' + (columnDiff.onlyInA.length === 1 ? 'column' : 'columns') + ' in ' + escapeHtml(comparisonLabel));
			}
			if (columnDiff.onlyInB.length > 0) {
				parts.push(String(columnDiff.onlyInB.length) + ' extra ' + (columnDiff.onlyInB.length === 1 ? 'column' : 'columns') + ' in ' + escapeHtml(comparisonLabel));
			}
			diffLabel = ' (' + parts.join(', ') + ')';
			const titleParts = ['View diff'];
			if (columnDiff.onlyInA.length > 0) {
				titleParts.push('Missing in ' + comparisonLabel + ': ' + columnDiff.onlyInA.join(', '));
			}
			if (columnDiff.onlyInB.length > 0) {
				titleParts.push('Extra in ' + comparisonLabel + ': ' + columnDiff.onlyInB.join(', '));
			}
			diffTitle = titleParts.join('\n');
		} else if (hasRowDiff && !hasColumnDiff) {
			// Only row differences
			diffLabel = ' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + escapeHtml(comparisonLabel) +
				')';
			diffTitle = 'View diff\nUnmatched rows: ' + String(onlyACount) + ' in ' + sourceLabel + ', ' + String(onlyBCount) + ' in ' + comparisonLabel;
		} else if (hasColumnDiff && hasRowDiff) {
			// Both column and row differences
			const colParts = [];
			if (columnDiff.onlyInA.length > 0) {
				colParts.push(String(columnDiff.onlyInA.length) + ' missing');
			}
			if (columnDiff.onlyInB.length > 0) {
				colParts.push(String(columnDiff.onlyInB.length) + ' extra');
			}
			diffLabel = ' (' + colParts.join('/') + ' columns, ' +
				String(onlyACount + onlyBCount) + ' unmatched ' + pluralRows(onlyACount + onlyBCount) + ')';
			diffTitle = 'View diff\nColumn differences and row differences detected.';
		}

		// Use JSON.stringify to produce a valid JS string literal (double-quoted) so the
		// inline onclick handler never breaks due to escaping.
		const aBoxIdLit = JSON.stringify(String(sourceBoxId || ''));
		const bBoxIdLit = JSON.stringify(String(comparisonBoxId || ''));
		dataMessage =
			'<span class="comparison-data-diff-icon" aria-hidden="true">\u26a0</span> ' +
			'<a href="#" class="comparison-data-diff comparison-diff-link" ' +
			"onclick='try{openDiffViewModal({ aBoxId: " + aBoxIdLit + ", bBoxId: " + bBoxIdLit + " })}catch{}; return false;' " +
			'title="' + diffTitle.replace(/"/g, '&quot;') + '">Data differs' + diffLabel + '</a>';
	}
	
	// Create or update comparison summary banner
	const comparisonBox = document.getElementById(comparisonBoxId) as any;
	if (!comparisonBox) {
		return;
	}
	
	// Find or create the banner element
	let banner = comparisonBox.querySelector('.comparison-summary-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.className = 'comparison-summary-banner';
		// Insert banner right before the editor wrapper (below the header).
		const editorWrapper = comparisonBox.querySelector('.query-editor-wrapper');
		if (editorWrapper && editorWrapper.parentNode) {
			editorWrapper.parentNode.insertBefore(banner, editorWrapper);
		}
	}
	
	banner.innerHTML = `
		<div class="comparison-summary-content">
			<strong>How do the two queries compare?</strong>
			<div class="comparison-metrics">
				<div class="comparison-metric">\u26a1 Execution speed: ${perfMessage}</div>
				${cpuMessage || ''}
				${memoryMessage || ''}
				${extentsMessage || ''}
				${cacheMessage || ''}
				<div class="comparison-metric">\ud83d\udccb Data returned: ${dataMessage}</div>
			</div>
		</div>
	`;
	try {
		const acceptTooltip = dataMatches
			? (warningNeeded
				? 'Data matches, but row/column ordering or header details differ. Accept optimizations with caution.'
				: 'Results match. Accept optimizations.')
			: 'Results differ. Accept optimizations is enabled — review the diff before accepting.';
		__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, true, acceptTooltip);
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyComparisonSummaryVisibility(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }

	// Notify the extension backend so it can coordinate validation retries.
	try {
		postMessageToHost({
			type: 'comparisonSummary',
			sourceBoxId: String(sourceBoxId || ''),
			comparisonBoxId: String(comparisonBoxId || ''),
			dataMatches: !!dataMatches,
			headersMatch: !!columnHeaderNamesMatch,
			rowOrderMatches: !!rowOrderMatches,
			columnOrderMatches: !!columnOrderMatches
		});
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoEnsureOptimizePrepByBoxId() {
	try {
		if (!window.__kustoOptimizePrepByBoxId || typeof window.__kustoOptimizePrepByBoxId !== 'object') {
			window.__kustoOptimizePrepByBoxId = {};
		}
		return window.__kustoOptimizePrepByBoxId;
	} catch {
		return {};
	}
}

export function __kustoHideOptimizePromptForBox( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (host) {
		host.style.display = 'none';
		host.innerHTML = '';
	}
	try {
		const pending = __kustoEnsureOptimizePrepByBoxId();
		delete pending[boxId];
	} catch (e) { console.error('[kusto]', e); }

	try {
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset && optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	try {
		__kustoSetOptimizeInProgress(boxId, false, '');
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetOptimizeInProgress( boxId: any, inProgress: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (!statusEl || !cancelBtn) {
			return;
		}
		const on = !!inProgress;
		try {
			if (optimizeBtn && optimizeBtn.dataset) {
				if (on) {
					optimizeBtn.dataset.kustoOptimizeInProgress = '1';
					optimizeBtn.disabled = true;
				} else {
					delete optimizeBtn.dataset.kustoOptimizeInProgress;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		statusEl.style.display = on ? '' : 'none';
		cancelBtn.style.display = on ? '' : 'none';
		if (on) {
			statusEl.textContent = String(statusText || 'Optimizing…');
			cancelBtn.disabled = false;

			try {
				const text = String(statusText || '');
				const shouldStartSpinner = /waiting\s+for\s+copilot\s+response/i.test(text);
				const spinnerAlreadyOn = !!(optimizeBtn && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeSpinnerActive === '1');
				if (optimizeBtn && (shouldStartSpinner || spinnerAlreadyOn)) {
					if (!optimizeBtn.dataset.originalContent) {
						optimizeBtn.dataset.originalContent = optimizeBtn.innerHTML;
					}
					optimizeBtn.dataset.kustoOptimizeSpinnerActive = '1';
					optimizeBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
				}
			} catch (e) { console.error('[kusto]', e); }
		} else {
			statusEl.textContent = '';
			cancelBtn.disabled = false;
			try {
				if (optimizeBtn && optimizeBtn.dataset) {
					delete optimizeBtn.dataset.kustoOptimizeSpinnerActive;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoUpdateOptimizeStatus( boxId: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		if (!statusEl) return;
		statusEl.textContent = String(statusText || '');
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoCancelOptimizeQuery( boxId: any) {
	try {
		__kustoUpdateOptimizeStatus(boxId, 'Canceling…');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({
			type: 'cancelOptimizeQuery',
			boxId: String(boxId || '')
		});
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoShowOptimizePromptLoading( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-loading">Loading optimization options…</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';
}

const __kustoOptimizeModelStorageKey = 'kusto.optimize.lastModelId';

export function __kustoGetLastOptimizeModelId() {
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
		if (state && state.lastOptimizeModelId) {
			return String(state.lastOptimizeModelId);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		return String(localStorage.getItem(__kustoOptimizeModelStorageKey) || '');
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoSetLastOptimizeModelId( modelId: any) {
	const id = String(modelId || '');
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
		state.lastOptimizeModelId = id;
		if (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.setState) {
			_win.vscode.setState(state);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (id) {
			localStorage.setItem(__kustoOptimizeModelStorageKey, id);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoApplyOptimizeQueryOptions( boxId: any, models: any, selectedModelId: any, promptText: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}

	const safeModels = Array.isArray(models) ? models : [];
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_model">Model</label>' +
		'<select class="optimize-config-select" id="' + boxId + '_optimize_model"></select>' +
		'</div>' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_prompt">Prompt</label>' +
		'<textarea class="optimize-config-textarea" id="' + boxId + '_optimize_prompt" spellcheck="false"></textarea>' +
		'</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-run-btn" onclick="__kustoRunOptimizeQueryWithOverrides(\'' + boxId + '\')">Optimize</button>' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';

	const selectEl = document.getElementById(boxId + '_optimize_model') as any;
	if (selectEl) {
		selectEl.innerHTML = '';
		for (const m of safeModels) {
			if (!m || !m.id) {
				continue;
			}
			const opt = document.createElement('option');
			opt.value = String(m.id);
			const label = String(m.label || m.id);
			const id = String(m.id);
			opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
			opt.setAttribute('data-short-label', label);
			selectEl.appendChild(opt);
		}

		const preferredModelId = __kustoGetLastOptimizeModelId();
		let preferredExists = false;
		if (preferredModelId) {
			for (let i = 0; i < selectEl.options.length; i++) {
				if (selectEl.options[i].value === preferredModelId) {
					preferredExists = true;
					break;
				}
			}
		}

		if (preferredExists) {
			selectEl.value = preferredModelId;
		} else if (selectedModelId) {
			selectEl.value = String(selectedModelId);
		}
		if (!selectEl.value && selectEl.options && selectEl.options.length > 0) {
			selectEl.selectedIndex = 0;
		}
	}

	const promptEl = document.getElementById(boxId + '_optimize_prompt') as any;
	if (promptEl) {
		promptEl.value = String(promptText || '');
	}
}

function __kustoRunOptimizeQueryWithOverrides( boxId: any) {
	const pending = __kustoEnsureOptimizePrepByBoxId();
	const req = pending[boxId];
	if (!req) {
		try { postMessageToHost({ type: 'showInfo', message: 'Optimization request is no longer available. Please try again.' }); } catch (e) { console.error('[kusto]', e); }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}

	// Optimization naming rule:
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - The optimized section will then use "<source name> (optimized)"
	try {
		let sourceName = __kustoGetSectionName(boxId);
		if (!sourceName) {
			sourceName = __kustoPickNextAvailableSectionLetterName(boxId);
			__kustoSetSectionName(boxId, sourceName);
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		}
		if (sourceName) {
			req.queryName = sourceName;
		}
	} catch (e) { console.error('[kusto]', e); }

	const modelId = (document.getElementById(boxId + '_optimize_model') as any || {}).value || '';
	const promptText = (document.getElementById(boxId + '_optimize_prompt') as any || {}).value || '';
	try {
		__kustoSetLastOptimizeModelId(modelId);
	} catch (e) { console.error('[kusto]', e); }

	// Close prompt UI and show spinner on the main optimize button
	try {
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (host) {
			host.style.display = 'none';
			host.innerHTML = '';
		}
	} catch (e) { console.error('[kusto]', e); }

	const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
	if (optimizeBtn) {
		optimizeBtn.disabled = true;
		const originalContent = optimizeBtn.innerHTML;
		optimizeBtn.dataset.originalContent = originalContent;
	}
	try {
		__kustoSetOptimizeInProgress(boxId, true, 'Starting optimization…');
	} catch (e) { console.error('[kusto]', e); }

	try {
		postMessageToHost({
			type: 'optimizeQuery',
			query: String(req.query || ''),
			connectionId: String(req.connectionId || ''),
			database: String(req.database || ''),
			boxId,
			queryName: String(req.queryName || ''),
			modelId: String(modelId || ''),
			promptText: String(promptText || '')
		});
		delete pending[boxId];
	} catch (err: any) {
		console.error('Error sending optimization request:', err);
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to start query optimization' }); } catch (e) { console.error('[kusto]', e); }
		// Restore button state
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
		__kustoHideOptimizePromptForBox(boxId);
	}
}

export async function optimizeQueryWithCopilot( boxId: any, comparisonQueryOverride: any, options: any) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return '';
	}
	const model = editor.getModel();
	if (!model) {
		return '';
	}

	const shouldExecute = !(options && options.skipExecute === true);
	const isManualCompareOnly = !shouldExecute;

	// Defensive: opening the comparison/diff view should never trigger/keep any
	// optimize (LLM) prompt state. If the optimize prompt was open or pending from
	// earlier, clear it so the diff view remains strictly non-LLM.
	if (isManualCompareOnly) {
		try { __kustoHideOptimizePromptForBox(boxId); } catch (e) { console.error('[kusto]', e); }
		try { __kustoSetOptimizeInProgress(boxId, false, ''); } catch (e) { console.error('[kusto]', e); }
	}

	// Hide results to keep the UI focused during comparison setup.
	try { __kustoSetResultsVisible(boxId, false); } catch (e) { console.error('[kusto]', e); }

	const query = model.getValue() || '';
	if (!query.trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'No query to compare' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	const overrideText = (typeof comparisonQueryOverride === 'string') ? String(comparisonQueryOverride || '') : '';
	// eslint-disable-next-line eqeqeq
	if (comparisonQueryOverride != null && !overrideText.trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'No comparison query provided' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	// Optimization naming rule (applies when we are creating an "optimized" comparison section):
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - Name the optimized section "<source name> (optimized)"
	//
	// This applies to:
	// - The Copilot optimize flow (optimized override query provided)
	// - The "Compare two queries" button (creates the optimized comparison section first)
	// eslint-disable-next-line eqeqeq
	const isCompareButtonScenario = isManualCompareOnly && (comparisonQueryOverride == null);
	// eslint-disable-next-line eqeqeq
	const isOptimizeScenario = ((comparisonQueryOverride != null) && !!overrideText.trim()) || isCompareButtonScenario;
	let sourceNameForOptimize = '';
	let desiredOptimizedName = '';
	if (isOptimizeScenario) {
		try {
			const nameInput = null;
			sourceNameForOptimize = __kustoGetSectionName(boxId);
			if (!sourceNameForOptimize) {
				sourceNameForOptimize = __kustoPickNextAvailableSectionLetterName(boxId);
				__kustoSetSectionName(boxId, sourceNameForOptimize);
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			}
			if (sourceNameForOptimize) {
				desiredOptimizedName = sourceNameForOptimize + ' (optimized)';
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	if (!database) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}

	// If a comparison already exists for this source, reuse it.
	try {
		const existingComparisonBoxId = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId])
			? optimizationMetadataByBoxId[boxId].comparisonBoxId
			: '';
		if (existingComparisonBoxId) {
			const comparisonBoxEl = document.getElementById(existingComparisonBoxId) as any;
			const comparisonEditor = queryEditors && queryEditors[existingComparisonBoxId];
			if (comparisonBoxEl && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
				let nextComparisonQuery = overrideText.trim() ? overrideText : query;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						nextComparisonQuery = window.__kustoPrettifyKustoText(nextComparisonQuery);
					}
				} catch (e) { console.error('[kusto]', e); }
				try { comparisonEditor.setValue(nextComparisonQuery); } catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
						optimizationMetadataByBoxId[existingComparisonBoxId] = optimizationMetadataByBoxId[existingComparisonBoxId] || {};
						optimizationMetadataByBoxId[existingComparisonBoxId].sourceBoxId = boxId;
						optimizationMetadataByBoxId[existingComparisonBoxId].isComparison = true;
						optimizationMetadataByBoxId[existingComparisonBoxId].originalQuery = queryEditors[boxId] ? queryEditors[boxId].getValue() : query;
						optimizationMetadataByBoxId[existingComparisonBoxId].optimizedQuery = nextComparisonQuery;
						optimizationMetadataByBoxId[boxId] = optimizationMetadataByBoxId[boxId] || {};
						optimizationMetadataByBoxId[boxId].comparisonBoxId = existingComparisonBoxId;
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof __kustoSetLinkedOptimizationMode === 'function') {
						__kustoSetLinkedOptimizationMode(boxId, existingComparisonBoxId, true);
					}
				} catch (e) { console.error('[kusto]', e); }
				// Set the comparison box name.
				try {
					if (desiredOptimizedName) {
						__kustoSetSectionName(existingComparisonBoxId, desiredOptimizedName);
						try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
					} else {
						const currentName = __kustoGetSectionName(existingComparisonBoxId);
						let shouldReplace = !currentName;
						if (!shouldReplace) {
							const upper = currentName.toUpperCase();
							if (upper.endsWith(' (COMPARISON)') || upper.endsWith(' (OPTIMIZED)')) {
								shouldReplace = true;
							}
						}
						if (shouldReplace) {
							__kustoSetSectionName(existingComparisonBoxId, __kustoPickNextAvailableSectionLetterName(existingComparisonBoxId));
							try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof __kustoSetResultsVisible === 'function') {
						__kustoSetResultsVisible(boxId, false);
						__kustoSetResultsVisible(existingComparisonBoxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				if (shouldExecute) {
					try {
						executeQuery(boxId);
						setTimeout(() => {
							try { executeQuery(existingComparisonBoxId); } catch (e) { console.error('[kusto]', e); }
						}, 100);
					} catch (e) { console.error('[kusto]', e); }
				}
				return existingComparisonBoxId;
			}
			// Stale mapping: comparison was removed; clear and fall back to creating a new one.
			try {
				if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
					delete optimizationMetadataByBoxId[boxId];
					delete optimizationMetadataByBoxId[existingComparisonBoxId];
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }

	// Do not auto-name the source section for plain comparisons.
	// For optimization scenarios, we already ensured a name above.
	let queryName = sourceNameForOptimize || __kustoGetSectionName(boxId);
	if (!desiredOptimizedName && isOptimizeScenario && queryName) {
		desiredOptimizedName = queryName + ' (optimized)';
	}

	// Create a comparison query box below the source box.
	// If a query override is provided, compare source query vs the provided query.
	let comparisonQuery = overrideText.trim() ? overrideText : query;
	try {
		if (typeof window.__kustoPrettifyKustoText === 'function') {
			comparisonQuery = window.__kustoPrettifyKustoText(comparisonQuery);
		}
	} catch (e) { console.error('[kusto]', e); }

	let comparisonBoxId = '';
	try {
		comparisonBoxId = addQueryBox({
			id: 'query_cmp_' + Date.now(),
			initialQuery: comparisonQuery,
			isComparison: true,
			defaultResultsVisible: false
		});
	} catch (err: any) {
		console.error('Error creating comparison box:', err);
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to create comparison section' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}

	try {
		if (typeof __kustoSetResultsVisible === 'function') {
			__kustoSetResultsVisible(boxId, false);
			__kustoSetResultsVisible(comparisonBoxId, false);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof __kustoSetLinkedOptimizationMode === 'function') {
			__kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, true);
		}
	} catch (e) { console.error('[kusto]', e); }

	// Store comparison metadata (reuses the existing optimization comparison flow).
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			optimizationMetadataByBoxId[comparisonBoxId] = {
				sourceBoxId: boxId,
				isComparison: true,
				originalQuery: queryEditors[boxId] ? queryEditors[boxId].getValue() : query,
				optimizedQuery: comparisonQuery
			};
			optimizationMetadataByBoxId[boxId] = {
				comparisonBoxId: comparisonBoxId
			};
		}
	} catch (e) { console.error('[kusto]', e); }

	// Position the comparison box right after the source box.
	try {
		const sourceBox = document.getElementById(boxId) as any;
		const comparisonBox = document.getElementById(comparisonBoxId) as any;
		if (sourceBox && comparisonBox && sourceBox.parentNode) {
			sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
		}
	} catch (e) { console.error('[kusto]', e); }

	// Set connection and database to match source.
	try {
		const compKwEl = __kustoGetQuerySectionElement(comparisonBoxId);
		if (compKwEl) {
			if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
			if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
			compKwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: comparisonBoxId, connectionId: connectionId },
				bubbles: true, composed: true,
			}));
			setTimeout(() => {
				try {
					if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
				} catch (e) { console.error('[kusto]', e); }
			}, 100);
		}
	} catch (e) { console.error('[kusto]', e); }

	// Set the query name.
	try {
		if (desiredOptimizedName) {
			__kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
		} else {
			const existing = __kustoGetSectionName(comparisonBoxId);
			if (!existing) {
				__kustoSetSectionName(comparisonBoxId, __kustoPickNextAvailableSectionLetterName(comparisonBoxId));
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	if (shouldExecute) {
		// Execute both queries for comparison.
		try {
			executeQuery(boxId);
			setTimeout(() => {
				try { executeQuery(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
			}, 100);
		} catch (e) { console.error('[kusto]', e); }
	}

	return comparisonBoxId;
}

// ── Run readiness, execution core ──

const __kustoIsValidConnectionIdForRun = __kustoIsValidConnectionIdForRun_pure;

function __kustoGetEffectiveSelectionOwnerIdForRun( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof window.__kustoGetSelectionOwnerBoxId === 'function') {
			return String(window.__kustoGetSelectionOwnerBoxId(id) || id).trim();
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
}

export function __kustoIsRunSelectionReady( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;

	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);

	// If a favorites selection is still staging/applying, don't allow Run.
	try {
		const pending1 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]);
		const pending2 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[ownerId]);
		if (pending1 || pending2) {
			return false;
		}
	} catch (e) { console.error('[kusto]', e); }

	const connectionId = __kustoGetConnectionId(ownerId);
	const database = __kustoGetDatabase(ownerId);

	if (!__kustoIsValidConnectionIdForRun(connectionId)) return false;
	if (!database) return false;

	// If DB selection is still being resolved (favorites/restore), block Run.
	try {
		const dbEl: any = null; // Legacy: never defined, kept for safety
		const desiredPending = !!(dbEl && dbEl.dataset && String(dbEl.dataset.desired || '').trim());
		if (desiredPending) return false;
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (false) return false; // Legacy: dbEl was never defined in this function
	} catch (e) { console.error('[kusto]', e); }

	return true;
}

function __kustoHasValidFavoriteSelection( ownerBoxId: any) {
	try {
		const id = String(ownerBoxId || '').trim();
		if (!id) return false;
		// Treat "favorite selected" as: the current (clusterUrl, db) matches a known favorite.
		const clusterUrl = String(__kustoGetCurrentClusterUrlForBox(id) || '').trim();
		const db = String(__kustoGetCurrentDatabaseForBox(id) || '').trim();
		if (!clusterUrl || !db) return false;
		return !!__kustoFindFavorite(clusterUrl, db);
	} catch {
		return false;
	}
}

function __kustoClearSchemaSummaryIfNoSelection( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);
	let connectionId = __kustoGetConnectionId(ownerId);
	let database = __kustoGetDatabase(ownerId);

	// If neither a database nor a favorite is selected, blank the schema summary to avoid stale counts.
	const hasValidCluster = typeof __kustoIsValidConnectionIdForRun === 'function'
		? __kustoIsValidConnectionIdForRun(connectionId)
		: !!connectionId;
	const shouldClear = ((!hasValidCluster || !database) && !__kustoHasValidFavoriteSelection(ownerId));

	// Keep the schema refresh button in sync: hide it when selection isn't valid.
	try {
		const btn = document.getElementById(id + '_schema_refresh') as any;
		if (btn) {
			btn.style.display = shouldClear ? 'none' : '';
		}
	} catch (e) { console.error('[kusto]', e); }

	if (shouldClear) {
		try {
			if (schemaByBoxId) {
				delete schemaByBoxId[id];
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const kwEl = __kustoGetQuerySectionElement(id);
			if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
				kwEl.setSchemaInfo({ status: 'not-loaded', statusText: 'Not loaded', cached: false, tables: undefined, cols: undefined, funcs: undefined, errorMessage: undefined });
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

window.__kustoUpdateRunEnabledForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	const runToggle = document.getElementById(id + '_run_toggle') as any;
	const disabledTooltip = 'Select a cluster and database first (or select a favorite)';

	// If a query is currently executing for this box, keep disabled.
	try {
		if (queryExecutionTimers && queryExecutionTimers[id]) {
			if (runBtn) runBtn.disabled = true;
			if (runToggle) runToggle.disabled = true;
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Also keep schema summary in sync with selection state.
	try { __kustoClearSchemaSummaryIfNoSelection(id); } catch (e) { console.error('[kusto]', e); }

	const enabled = __kustoIsRunSelectionReady(id);
	if (runBtn) {
		runBtn.disabled = !enabled;
		try {
			// When disabled, provide a helpful tooltip instead of looking "broken".
			const modeLabel = getRunModeLabelText(getRunMode(id));
			runBtn.title = enabled ? modeLabel : (modeLabel + '\n' + disabledTooltip);
			// Also keep ARIA label helpful when disabled.
			runBtn.setAttribute('aria-label', enabled ? modeLabel : disabledTooltip);
		} catch (e) { console.error('[kusto]', e); }
	}
	// Keep the split dropdown usable so users can change run mode even before selection is ready.
	if (runToggle) runToggle.disabled = false;
};

window.__kustoUpdateRunEnabledForAllBoxes = function () {
	try {
		for (const id of (queryBoxes || [])) {
			try { window.__kustoUpdateRunEnabledForBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
};

// formatElapsed imported from ../shared/comparisonUtils.ts

export function setQueryExecuting( boxId: any, executing: any) {
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	const runToggle = document.getElementById(boxId + '_run_toggle') as any;
	const status = document.getElementById(boxId + '_exec_status') as any;
	const elapsed = document.getElementById(boxId + '_exec_elapsed') as any;
	const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;

	if (queryExecutionTimers[boxId]) {
		clearInterval(queryExecutionTimers[boxId]);
		delete queryExecutionTimers[boxId];
	}

	if (executing) {
		if (runBtn) {
			runBtn.disabled = true;
		}
		if (runToggle) {
			runToggle.disabled = true;
		}
		if (cancelBtn) {
			cancelBtn.disabled = false;
			cancelBtn.style.display = 'flex';
		}
		closeRunMenu(boxId);
		if (status) {
			status.style.display = 'inline-flex';
		}
		if (elapsed) {
			elapsed.textContent = '0:00';
		}

		// If results are already visible, grey them out while the new query runs
		// so the user has visual context. If results are not visible, leave them hidden.
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv && resultsDiv.innerHTML.trim()) {
				resultsDiv.classList.add('is-stale');
			}
		} catch (e) { console.error('[kusto]', e); }

		const start = performance.now();
		queryExecutionTimers[boxId] = setInterval(() => {
			if (elapsed) {
				elapsed.textContent = formatElapsed(performance.now() - start);
			}
		}, 1000);
		return;
	}

	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		} else {
			if (runBtn) {
				runBtn.disabled = false;
			}
			if (runToggle) {
				runToggle.disabled = false;
			}
		}
	} catch {
		if (runBtn) {
			runBtn.disabled = false;
		}
		if (runToggle) {
			runToggle.disabled = false;
		}
	}
	if (cancelBtn) {
		cancelBtn.disabled = true;
		cancelBtn.style.display = 'none';
	}
	if (status) {
		status.style.display = 'none';
	}

	// Remove stale overlay — execution finished (results or error will replace content).
	try {
		const resultsDiv = document.getElementById(boxId + '_results') as any;
		if (resultsDiv) {
			resultsDiv.classList.remove('is-stale');
		}
	} catch (e) { console.error('[kusto]', e); }
}

function cancelQuery( boxId: any) {
	try {
		const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({ type: 'cancelQuery', boxId: boxId });
	} catch (e) { console.error('[kusto]', e); }
}

export function executeQuery( boxId: any, mode?: any) {
	const effectiveMode = mode || getRunMode(boxId);
	try {
		if (typeof window.__kustoClearAutoFindInQueryEditor === 'function') {
			window.__kustoClearAutoFindInQueryEditor(boxId);
		}
	} catch (e) { console.error('[kusto]', e); }
	const __kustoExtractStatementAtCursor = (editor: any) => {
		try {
			if (typeof window.__kustoExtractStatementTextAtCursor === 'function') {
				return window.__kustoExtractStatementTextAtCursor(editor);
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') {
				return null;
			}
			const model = editor.getModel();
			const pos = editor.getPosition();
			if (!model || !pos || typeof model.getLineCount !== 'function') {
				return null;
			}
			const cursorLine = pos.lineNumber;
			if (typeof cursorLine !== 'number' || !isFinite(cursorLine) || cursorLine < 1) {
				return null;
			}
			const lineCount = model.getLineCount();
			if (!lineCount || cursorLine > lineCount) {
				return null;
			}

			// Statements are separated by one or more blank lines.
			// Blank lines inside triple-backtick (```) multi-line string literals are NOT separators.
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			let inTripleBacktick = false;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
				// Track triple-backtick state.
				let tripleCount = 0;
				for (let ci = 0; ci < lineText.length - 2; ci++) {
					if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
						tripleCount++;
						ci += 2;
					}
				}
				if (tripleCount % 2 === 1) inTripleBacktick = !inTripleBacktick;
				if (inTripleBacktick) {
					if (!inBlock) { startLine = ln; inBlock = true; }
					continue;
				}
				const isBlank = !String(lineText || '').trim();
				if (isBlank) {
					if (inBlock) {
						blocks.push({ startLine, endLine: ln - 1 });
						inBlock = false;
					}
					continue;
				}
				if (!inBlock) {
					startLine = ln;
					inBlock = true;
				}
			}
			if (inBlock) {
				blocks.push({ startLine, endLine: lineCount });
			}

			const block = blocks.find((b: any) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (!block) {
				// Cursor is on a blank separator line (or the editor is empty).
				return null;
			}

			const endCol = (typeof model.getLineMaxColumn === 'function')
				? model.getLineMaxColumn(block.endLine)
				: 1;
			const range = {
				startLineNumber: block.startLine,
				startColumn: 1,
				endLineNumber: block.endLine,
				endColumn: endCol
			};
			let text = '';
			try {
				text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
			} catch {
				text = '';
			}
			const trimmed = String(text || '').trim();
			return trimmed || null;
		} catch {
			return null;
		}
	};

	const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the user has text selected in the editor, run only the selected text.
	let usedSelection = false;
	try {
		if (editor && typeof editor.getSelection === 'function' && typeof editor.getModel === 'function') {
			const sel = editor.getSelection();
			if (sel && !sel.isEmpty()) {
				const model = editor.getModel();
				if (model && typeof model.getValueInRange === 'function') {
					const selectedText = model.getValueInRange(sel);
					if (selectedText && selectedText.trim()) {
						query = selectedText;
						usedSelection = true;
					}
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	// If the editor has multiple statements (blank-line separated), run only the statement at cursor.
	// Skip if the user explicitly selected text — their selection takes priority.
	// IMPORTANT: Do NOT add checks for hasTextFocus or activeQueryEditorBoxId here!
	// When clicking the Run button, the editor loses focus before this code executes, which would
	// cause the full editor content to be sent instead of just the active statement. This was a
	// regression bug - always check for multiple statements and extract at cursor unconditionally.
	try {
		if (editor && !usedSelection) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof window.__kustoGetStatementBlocksFromModel === 'function')
				? window.__kustoGetStatementBlocksFromModel(model)
				: [];
			const hasMultipleStatements = blocks && blocks.length > 1;
			if (hasMultipleStatements) {
				const statement = __kustoExtractStatementAtCursor(editor);
				if (statement) {
					query = statement;
				} else {
					// Cursor is on a separator line between statements.
					try {
						postMessageToHost({
							type: 'showInfo',
							message: 'Place the cursor inside a query statement (not on a separator) to run that statement.'
						});
					} catch (e) { console.error('[kusto]', e); }
					return;
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	let connectionId = __kustoGetConnectionId(boxId);
	let database = __kustoGetDatabase(boxId);
	let cacheEnabled = (document.getElementById(boxId + '_cache_enabled') as any).checked;
	const cacheValue = parseInt((document.getElementById(boxId + '_cache_value') as any).value) || 1;
	const cacheUnit = (document.getElementById(boxId + '_cache_unit') as any).value;

	let sourceBoxIdForComparison = '';
	let isComparisonBox = false;

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				isComparisonBox = true;
				sourceBoxIdForComparison = String(sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(sourceBoxId);
				const srcDb = __kustoGetDatabase(sourceBoxId);
				if (srcConnId) {
					connectionId = srcConnId;
				}
				if (srcDb) {
					database = srcDb;
				}
			}
			// While linked optimization exists, always disable caching for benchmark runs.
			const hasLinkedOptimization = !!(meta && meta.isComparison)
				|| !!(optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].comparisonBoxId);
			if (hasLinkedOptimization) {
				cacheEnabled = false;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Cache consistency policy for comparisons:
	// If the source box was last executed with caching enabled, rerun it once with caching disabled
	// before (or alongside) running the comparison box. This avoids cached-vs-live drift causing
	// false mismatches when queries are otherwise unchanged.
	try {
		if (isComparisonBox && sourceBoxIdForComparison) {
			const sourceLastRunUsedCaching = !!(lastRunCacheEnabledByBoxId[sourceBoxIdForComparison]);
			if (sourceLastRunUsedCaching) {
				// Prevent transient comparisons against stale cached source results.
				try {
					const resultsMap = ensureResultsStateMap();
					delete resultsMap[sourceBoxIdForComparison];
				} catch (e) { console.error('[kusto]', e); }
				try {
					__kustoLog(boxId, 'run.compare.rerunSourceNoCache', 'Rerunning source query with caching disabled', {
						sourceBoxId: sourceBoxIdForComparison
					});
				} catch (e) { console.error('[kusto]', e); }
				try {
					// This run will inherit the linked-optimization behavior and force cacheEnabled=false.
					executeQuery(sourceBoxIdForComparison, effectiveMode);
				} catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Safety: if a favorites switch is still pending/applying, do not run.
	try {
		const pending = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[boxId]);
		const dbEl = document.getElementById(boxId + '_database') as any;
		const desiredPending = !!(dbEl && dbEl.dataset && dbEl.dataset.desired);
		const dbDisabled = !!(dbEl && dbEl.disabled);
		if (pending || desiredPending || dbDisabled) {
			__kustoLog(boxId, 'run.blocked', 'Blocked run because selection is still updating', {
				pending,
				desiredPending,
				dbDisabled,
				connectionId,
				database
			}, 'warn');
			try { postMessageToHost({ type: 'showInfo', message: 'Waiting for the selected favorite to finish applying (loading databases/schema). Try Run again in a moment.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!database) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	__kustoLog(boxId, 'run.start', 'Executing query', { connectionId, database, queryMode: effectiveMode });

	setQueryExecuting(boxId, true);
	closeRunMenu(boxId);

	// Track the effective cacheEnabled value for this run.
	// When caching is enabled, the extension injects an extra (hidden) first line,
	// so error line numbers need to be adjusted for the visible editor.
	try {
		lastRunCacheEnabledByBoxId[boxId] = !!cacheEnabled;
	} catch (e) { console.error('[kusto]', e); }

	// Store the last executed box for result display
	pState.lastExecutedBox = boxId;

	postMessageToHost({
		type: 'executeQuery',
		query,
		queryMode: effectiveMode,
		connectionId,
		database,
		boxId,
		cacheEnabled,
		cacheValue,
		cacheUnit
	});
}

// ── Window bridges for remaining legacy callers ──
// __kustoSetResultsVisible bridge removed (D8) — exported, all consumers use ES imports.
// __kustoGetLastOptimizeModelId, __kustoSetLastOptimizeModelId bridges removed (Option A) — exported.
window.cancelQuery = cancelQuery;
window.executeQuery = executeQuery;
