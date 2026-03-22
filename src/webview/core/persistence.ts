// Persistence module — converted from legacy/persistence.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

import { normalizeClusterUrl, isLeaveNoTraceCluster, byteLengthUtf8, trySerializeQueryResult } from '../shared/persistence-utils';
import { postMessageToHost } from '../shared/webview-messages';
import { pState } from '../shared/persistence-state';
import { displayResult } from './results-state';
import {
	addQueryBox, removeQueryBox, updateConnectionSelects, toggleCacheControls,
	__kustoGetQuerySectionElement, __kustoSetSectionName, __kustoGetConnectionId, __kustoGetDatabase,
	__kustoSetAutoEnterFavoritesForBox, __kustoTryAutoEnterFavoritesModeForAllBoxes,
	__kustoClampResultsWrapperHeight,
	addPythonBox, addUrlBox, removePythonBox, removeUrlBox, pythonBoxes, urlBoxes,
} from './section-factory';
import {
	connections, queryBoxes, queryEditors, favoritesModeByBoxId, leaveNoTraceClusters,
	caretDocsEnabled, autoTriggerAutocompleteEnabled,
	setCaretDocsEnabled, setAutoTriggerAutocompleteEnabled
} from './state';
import { addChartBox, removeChartBox, chartBoxes } from '../sections/kw-chart-section';
import { addTransformationBox, removeTransformationBox, transformationBoxes } from '../sections/kw-transformation-section';
import { addMarkdownBox, removeMarkdownBox, markdownBoxes, markdownEditors } from '../sections/kw-markdown-section';
import { setRunMode, updateCaretDocsToggleButtons, updateAutoTriggerAutocompleteToggleButtons } from '../sections/kw-query-toolbar';
import { __kustoUpdateQueryResultsToggleButton, __kustoApplyResultsVisibility } from '../sections/query-execution.controller';
import { __kustoUpdateSchemaForFocusedBox } from '../monaco/monaco';

const _win = window;
// Persistence + .kqlx document round-tripping.
//
// The extension host stores the state as JSON in a .kqlx file.
// This file provides:
// - export: collect the current UI state
// - restore: rebuild the UI from a state object
// - debounced write-through: postMessage({type:'persistDocument'})

let __kustoPersistenceEnabled = false;
let __kustoPersistTimer: any = null;
let __kustoDocumentDataApplyCount = 0;
let __kustoHasAppliedDocument = false;
let __kustoLastAppliedDocumentUri = '';

// Thin wrapper kept for the window bridge export.
function __kustoNormalizeClusterUrl(clusterUrl: any) {
	return normalizeClusterUrl(clusterUrl);
}

/**
 * Check if a cluster URL is marked as "Leave no trace".
 * Delegates to the pure shared function, providing the window global.
 */
function __kustoIsLeaveNoTraceCluster(clusterUrl: any) {
	try {
		const list = leaveNoTraceClusters;
		return isLeaveNoTraceCluster(clusterUrl, Array.isArray(list) ? list : []);
	} catch {
		return false;
	}
}

// Document capabilities (set by extension host via the persistenceMode message).
// - allowedSectionKinds controls which add buttons are shown/enabled.
// - defaultSectionKind controls which section we create for an empty document.
// - upgradeRequestType controls which message we send when in compatibility mode.
// Defaults are set in pState (shared/persistence-state.ts).

export function __kustoApplyDocumentCapabilities() {
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((k: any) => String(k))
			: ['query', 'markdown', 'python', 'url'];

		// If no section kinds are allowed, hide the entire add-controls container.
		const addControlsContainer = document.querySelector('.add-controls') as HTMLElement | null;
		if (addControlsContainer) {
			addControlsContainer.style.display = allowed.length === 0 ? 'none' : '';
		}

		// Update inline buttons visibility.
		// NOTE: Buttons inside .add-controls-options share a common parent, so we hide
		// individual buttons directly rather than trying to hide a wrapper element.
		const btns = document.querySelectorAll('.add-controls-options .add-control-btn');
		for (const btn of btns as any) {
			try {
				const kind = btn && btn.getAttribute ? String(btn.getAttribute('data-add-kind') || '') : '';
				const visible = !kind || allowed.includes(kind);
				btn.style.display = visible ? '' : 'none';
			} catch (e) { console.error('[kusto]', e); }
		}

		// Update dropdown items visibility (for narrow viewport dropdown)
		const dropdownItems = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of dropdownItems as any) {
			try {
				const kind = item.getAttribute ? String(item.getAttribute('data-add-kind') || '') : '';
				const visible = !kind || allowed.includes(kind);
				item.style.display = visible ? '' : 'none';
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetCompatibilityMode(enabled: any) {
	try {
		pState.compatibilityMode = !!enabled;
		const msg = String(pState.compatibilityTooltip || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.');
		const wrappers = document.querySelectorAll('.add-controls .add-control-wrapper');
		for (const w of wrappers as any) {
			try {
				if (enabled) {
					w.title = msg;
				} else if (w.title === msg) {
					w.title = '';
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		const buttons = document.querySelectorAll('.add-controls .add-control-btn');
		for (const btn of buttons as any) {
			try {
				// Keep enabled; clicking will offer to upgrade.
				btn.disabled = false;
				btn.setAttribute('aria-disabled', 'false');
				// Tooltip is on wrapper span.
				btn.title = '';
			} catch (e) { console.error('[kusto]', e); }
		}

		// Apply visibility of add buttons based on allowed kinds.
		try { __kustoApplyDocumentCapabilities(); } catch (e) { console.error('[kusto]', e); }

		// If we just entered compatibility mode, ensure any early queued add clicks don't
		// accidentally create extra sections that can't be persisted.
		if (enabled) {
			try {
				pState.queryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRequestAddSection(kind: any) {
	const k = String(kind || '').trim();
	if (!k) return;

	// Respect allowed section kinds.
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((v: any) => String(v))
			: ['query', 'chart', 'markdown', 'python', 'url'];
		if (allowed.length > 0 && !allowed.includes(k)) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// For .kql/.csl compatibility files: offer upgrade instead of adding sections.
	try {
		if (pState.compatibilityMode) {
			try {
				// IMPORTANT: results persistence is debounced; if the user clicks "add chart" right
				// after executing, the current resultJson may not have been sent to the extension yet.
				// So capture the current state and send it along with the upgrade request.
				let state = null;
				try {
					if (typeof getKqlxState === 'function') {
						state = getKqlxState();
					}
				} catch (e) { console.error('[kusto]', e); }
				// Best-effort immediate persist so the extension has the latest state even if it
				// doesn't look at the upgrade payload (or if ordering differs).
				try {
					if (state) {
						postMessageToHost({ type: 'persistDocument', state, reason: 'upgrade' });
					}
				} catch (e) { console.error('[kusto]', e); }
				if (pState.upgradeRequestType === 'requestUpgradeToMdx') {
					postMessageToHost({ type: 'requestUpgradeToMdx', addKind: k, state });
				} else {
					postMessageToHost({ type: 'requestUpgradeToKqlx', addKind: k, state });
				}
			} catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Normal .kqlx flow.
	if (k === 'query') return addQueryBox();
	if (k === 'chart') return addChartBox();
	if (k === 'transformation') return addTransformationBox();
	if (k === 'markdown') return addMarkdownBox();
	if (k === 'python') return addPythonBox();
	if (k === 'url') return addUrlBox();
	// copilotQuery sections are deprecated; Copilot chat is now a per-editor toolbar toggle.
}

// Replace the early bootstrap stub (defined in queryEditor.js before all scripts load).
// In some browsers, relying on a global function declaration is not enough to override
// an existing window property, so assign explicitly.
try {
	_win.__kustoRequestAddSection = __kustoRequestAddSection;
} catch (e) { console.error('[kusto]', e); }

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
// (State maps are in pState — shared/persistence-state.ts.)
// Keep a cap to avoid ballooning the file, but try hard to keep *some* results
// (e.g. truncate rows) instead of dropping them entirely.
//
// Note: this is per-query-box, and the document can contain multiple boxes.
// We intentionally allow several MB because session.kqlx lives in extension global storage.
const __kustoMaxPersistedResultBytes = 5 * 1024 * 1024;
const __kustoMaxPersistedResultRowsHardCap = 5000;

// byteLengthUtf8 is now imported from shared/persistence-utils.ts

export function __kustoTryStoreQueryResult(boxId: any, result: any) {
	try {
		if (!boxId) return;
		const { json } = trySerializeQueryResult(result, __kustoMaxPersistedResultBytes, __kustoMaxPersistedResultRowsHardCap);
		if (json) {
			pState.queryResultJsonByBoxId[boxId] = json;
		} else {
			delete pState.queryResultJsonByBoxId[boxId];
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Called by main.js when query results arrive.
export function __kustoOnQueryResult(boxId: any, result: any) {
	__kustoTryStoreQueryResult(boxId, result);
	try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoFindQueryEditorWrapper(boxId: any, suffix: any) {
	try {
		const el = document.getElementById(boxId + suffix);
		let wrapper = (el && el.closest) ? el.closest('.query-editor-wrapper') as HTMLElement | null : null;
		if (!wrapper) {
			const box = document.getElementById(boxId);
			wrapper = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') as HTMLElement | null : null;
		}
		return wrapper;
	} catch {
		return null;
	}
}

function __kustoGetWrapperHeightPx(boxId: any, suffix: any) {
	try {
		// If the user manually resized, prefer the explicit height state.
		try {
			const map = pState.manualQueryEditorHeightPxByBoxId;
			const v = map ? map[boxId] : undefined;
			if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
				return Math.max(0, Math.round(v));
			}
		} catch (e) { console.error('[kusto]', e); }

		const wrapper = __kustoFindQueryEditorWrapper(boxId, suffix);
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		// Auto-resize can also set an inline height, but that should not get saved into .kqlx.
		// Only persist height if the user explicitly resized (wrapper has an inline height).
		// Otherwise, default layout can vary by window size/theme and would cause spurious "dirty" writes.
		const inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		if (!Number.isFinite(px)) return undefined;
		// If Monaco's content auto-resize set the height, do not persist.
		try {
			if (wrapper.dataset && wrapper.dataset.kustoAutoResized === 'true') {
				return undefined;
			}
		} catch (e) { console.error('[kusto]', e); }
		// Prefer the explicit user-resize marker, but accept any non-auto inline height.
		return Math.max(0, px);
	} catch {
		return undefined;
	}
}

function __kustoSetWrapperHeightPx(boxId: any, suffix: any, heightPx: any) {
	try {
		const wrapper = __kustoFindQueryEditorWrapper(boxId, suffix);
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		wrapper.style.height = Math.round(h) + 'px';
		try {
			wrapper.dataset.kustoUserResized = 'true';
		} catch (e) { console.error('[kusto]', e); }
		try {
			const editor = (queryEditors && queryEditors[boxId]) ? queryEditors[boxId] : null;
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoGetQueryResultsOutputHeightPx(boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_results_wrapper');
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		try {
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		let inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		// When results are hidden the wrapper is collapsed to 40px;
		// return the remembered pre-collapse height instead.
		try {
			const prevToggle = (wrapper.dataset && wrapper.dataset.kustoPreviousHeight) ? String(wrapper.dataset.kustoPreviousHeight).trim() : '';
			if (prevToggle && inlineHeight === '40px') {
				inlineHeight = prevToggle;
			}
		} catch (e) { console.error('[kusto]', e); }
		// If results were temporarily collapsed to auto, keep the user's last explicit height.
		if (!inlineHeight || inlineHeight === 'auto') {
			try {
				const prev = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight).trim() : '';
				if (prev) {
					inlineHeight = prev;
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (!inlineHeight || inlineHeight === 'auto') return undefined;
		const m = inlineHeight.match(/^([0-9]+)px$/i);
		if (!m) return undefined;
		const px = parseInt(m[1], 10);
		return Number.isFinite(px) ? Math.max(0, px) : undefined;
	} catch {
		return undefined;
	}
}

function __kustoSetQueryResultsOutputHeightPx(boxId: any, heightPx: any) {
	try {
		const wrapper = document.getElementById(boxId + '_results_wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		// Query results resizer bounds use ~900px max; keep persisted restore within that.
		const clamped = Math.max(120, Math.min(900, Math.round(h)));
		// If results are currently hidden, don't override the collapsed height.
		// Store the persisted height so toggling results back on restores it.
		let resultsHidden = false;
		try {
			resultsHidden = !!(pState.resultsVisibleByBoxId[boxId] === false);
		} catch (e) { console.error('[kusto]', e); }
		if (resultsHidden) {
			try { wrapper.dataset.kustoPreviousHeight = clamped + 'px'; } catch (e) { console.error('[kusto]', e); }
			try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
			return;
		}
		wrapper.style.height = clamped + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
		// If this section currently has short non-table content (errors, etc.), clamp on next tick.
		try {
			setTimeout(() => {
				try {
					__kustoClampResultsWrapperHeight(boxId);
				} catch (e) { console.error('[kusto]', e); }
			}, 0);
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function getKqlxState() {
	// Compatibility mode (.kql/.csl/.md): only a single section is supported.
	try {
		if (pState.compatibilityMode) {
			const singleKind = String(pState.compatibilitySingleKind || 'query');
			if (singleKind === 'markdown') {
				let firstMarkdownBoxId = null;
				try {
					const ids = Array.isArray(markdownBoxes) ? markdownBoxes : [];
					for (const id of ids) {
						if (typeof id === 'string' && id.startsWith('markdown_')) {
							firstMarkdownBoxId = id;
							break;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				let text = '';
				try {
					text = (firstMarkdownBoxId && markdownEditors && markdownEditors[firstMarkdownBoxId])
						? (markdownEditors[firstMarkdownBoxId].getValue() || '')
						: '';
				} catch (e) { console.error('[kusto]', e); }
				if (!text) {
					try {
						const pending = firstMarkdownBoxId
							? pState.pendingMarkdownTextByBoxId[firstMarkdownBoxId]
							: undefined;
						if (typeof pending === 'string') {
							text = pending;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				return {
					caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
					autoTriggerAutocompleteEnabled: (typeof autoTriggerAutocompleteEnabled === 'boolean') ? autoTriggerAutocompleteEnabled : false,
					sections: [{ type: 'markdown', text }]
				};
			}

			let firstQueryBoxId = null;
			try {
				const ids = Array.isArray(queryBoxes) ? queryBoxes : [];
				for (const id of ids) {
					if (typeof id === 'string' && id.startsWith('query_')) {
						firstQueryBoxId = id;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			const q = (firstQueryBoxId && queryEditors && queryEditors[firstQueryBoxId])
				? (queryEditors[firstQueryBoxId].getValue() || '')
				: '';
			let clusterUrl = '';
			let database = '';
			let resultJson = '';
			let favoritesMode;
			try {
				if (firstQueryBoxId) {
					// Selection (clusterUrl + database)
					try {
						const connectionId = __kustoGetConnectionId(firstQueryBoxId);
						if (connectionId && Array.isArray(connections)) {
							const conn = (connections || []).find((c: any) => c && String(c.id || '') === String(connectionId));
							clusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						database = __kustoGetDatabase(firstQueryBoxId);
					} catch (e) { console.error('[kusto]', e); }
					// Persisted results (in-memory)
					try {
						if (pState.queryResultJsonByBoxId[firstQueryBoxId]) {
							resultJson = String(pState.queryResultJsonByBoxId[firstQueryBoxId]);
						}
					} catch (e) { console.error('[kusto]', e); }
					// Favorites picker UI mode
					try {
						if (typeof favoritesModeByBoxId === 'object' && favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, firstQueryBoxId)) {
							favoritesMode = !!favoritesModeByBoxId[firstQueryBoxId];
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			return {
				caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
				autoTriggerAutocompleteEnabled: (typeof autoTriggerAutocompleteEnabled === 'boolean') ? autoTriggerAutocompleteEnabled : false,
				sections: [
					{
						type: 'query',
						query: q,
						...(clusterUrl ? { clusterUrl } : {}),
						...(database ? { database } : {}),
						// Leave no trace: don't persist results from sensitive clusters
						...(resultJson && !__kustoIsLeaveNoTraceCluster(clusterUrl) ? { resultJson } : {}),
						...(typeof favoritesMode === 'boolean' ? { favoritesMode } : {})
					}
				]
			};
		}
	} catch (e) { console.error('[kusto]', e); }

	const sections: any[] = [];
	const container = document.getElementById('queries-container');
	const children = container ? Array.from(container.children || []) : [];
	const sectionPrefixes = ['query_', 'chart_', 'transformation_', 'markdown_', 'python_', 'url_'];
	for (const child of children) {
		const id = child && child.id ? String(child.id) : '';
		if (!id) continue;

		// All section types are Lit components that implement serialize().
		const isSection = sectionPrefixes.some(prefix => id.startsWith(prefix));
		if (isSection) {
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try { sections.push((el as any).serialize()); } catch (e) { console.error('[kusto]', e); }
			}
			continue;
		}
	}

	// Re-inject passthrough dev notes sections (hidden, no DOM elements)
	try {
		for (const dn of pState.devNotesSections) {
			if (dn && dn.type === 'devnotes') sections.push(dn);
		}
	} catch (e) { console.error('[kusto]', e); }

	return {
		caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
		autoTriggerAutocompleteEnabled: (typeof autoTriggerAutocompleteEnabled === 'boolean') ? autoTriggerAutocompleteEnabled : false,
		sections
	};
}

let __kustoLastPersistSignature = '';
// In compatibility mode (no sidecar), only the query text is saved to disk.
// Track the last query text separately so cluster/database-only changes don't
// trigger unnecessary persistDocument messages that would dirty the file.
let __kustoLastCompatQueryText = '';

export function schedulePersist(reason?: any, immediate?: any) {
	if (!__kustoPersistenceEnabled || pState.restoreInProgress) {
		return;
	}
	try {
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
		}
		const r = (typeof reason === 'string' && reason) ? reason : '';
		const doPersist = () => {
			try {
				const state = getKqlxState();
				let sig = '';
				try { sig = JSON.stringify(state); } catch { sig = ''; }
				if (sig && sig === __kustoLastPersistSignature) {
					return;
				}

				// In compatibility mode (.kql/.csl/.md without companion file), the only
				// thing we persist to disk is the section text itself. Cluster/database
				// selection changes should NOT mark the document dirty because there is
				// nowhere to save that metadata. Skip the persist if only metadata changed.
				if (pState.compatibilityMode) {
					try {
						let compatQueryText = '';
						const sections = (state && Array.isArray(state.sections)) ? state.sections : [];
						const singleKind = String(pState.compatibilitySingleKind || 'query');
						let firstQ = null;
						for (let si = 0; si < sections.length; si++) {
							if (sections[si] && String(sections[si].type || '') === singleKind) {
								firstQ = sections[si];
								break;
							}
						}
						if (singleKind === 'markdown') {
							if (firstQ && typeof firstQ.text === 'string') {
								compatQueryText = firstQ.text;
							}
						} else {
							if (firstQ && typeof firstQ.query === 'string') {
								compatQueryText = firstQ.query;
							}
						}
						if (compatQueryText === __kustoLastCompatQueryText) {
							// Only metadata changed (cluster, database, etc.) — skip persist.
							// Still update the full signature so it stays in sync.
							if (sig) { __kustoLastPersistSignature = sig; }
							return;
						}
						__kustoLastCompatQueryText = compatQueryText;
					} catch (e) { console.error('[kusto]', e); }
				}

				if (sig) {
					__kustoLastPersistSignature = sig;
				}
				postMessageToHost({ type: 'persistDocument', state, reason: r });
			} catch (e) { console.error('[kusto]', e); }
		};
		if (immediate) {
			// Immediate persist - no debounce
			doPersist();
		} else {
			__kustoPersistTimer = setTimeout(doPersist, 400);
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Best-effort flush: when the user closes the editor, try to persist the latest state immediately.
// (The extension decides whether to actually auto-save to disk; for session.kqlx it does.)
try {
	window.addEventListener('beforeunload', () => {
		try {
			// Only force a final flush for the session file.
			if (!pState.isSessionFile) {
				return;
			}
			if (!__kustoPersistenceEnabled || pState.restoreInProgress) {
				return;
			}
			const state = getKqlxState();
			postMessageToHost({ type: 'persistDocument', state, flush: true, reason: 'flush' });
		} catch (e) { console.error('[kusto]', e); }
	});
} catch (e) { console.error('[kusto]', e); }

function __kustoClearAllSections() {
	try {
		for (const id of (queryBoxes || []).slice()) {
			try { removeQueryBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (chartBoxes || []).slice()) {
			try { removeChartBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (transformationBoxes || []).slice()) {
			try { removeTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (markdownBoxes || []).slice()) {
			try { removeMarkdownBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (pythonBoxes || []).slice()) {
			try { removePythonBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		for (const id of (urlBoxes || []).slice()) {
			try { removeUrlBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	// Clear passthrough dev notes sections
	try { pState.devNotesSections = []; } catch (e) { console.error('[kusto]', e); }
}

function applyKqlxState(state: any) {
	pState.restoreInProgress = true;
	try {
		__kustoPersistenceEnabled = false;

		// Reset persisted results when loading a new document.
		try { pState.queryResultJsonByBoxId = {}; } catch (e) { console.error('[kusto]', e); }

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };

		// Respect a global user preference (persisted in extension globalState) once it exists.
		// Only fall back to document state if the user has never explicitly toggled the feature.
		const userSet = (() => {
			try {
				return !!_win.__kustoCaretDocsEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!userSet && typeof s.caretDocsEnabled === 'boolean') {
			setCaretDocsEnabled(!!s.caretDocsEnabled);
			try { updateCaretDocsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
		}

		const autoUserSet = (() => {
			try {
				return !!_win.__kustoAutoTriggerAutocompleteEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!autoUserSet && typeof s.autoTriggerAutocompleteEnabled === 'boolean') {
			setAutoTriggerAutocompleteEnabled(!!s.autoTriggerAutocompleteEnabled);
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch (e) { console.error('[kusto]', e); }
		}

		// Compatibility mode (single-section plain text files): force exactly one editor and ignore all other sections.
		if (pState.compatibilityMode) {
			const singleKind = String(pState.compatibilitySingleKind || 'query');
			let singleText = '';
			let suggestedClusterUrl = '';
			let suggestedDatabase = '';
			try {
				const sections = Array.isArray(s.sections) ? s.sections : [];
				const first = sections.find((sec: any) => sec && String(sec.type || '') === singleKind);
				if (singleKind === 'markdown') {
					singleText = first ? String(first.text || '') : '';
				} else {
					singleText = first ? String(first.query || '') : '';
					// Optional: extension host can provide a best-effort suggested selection for .kql/.csl.
					try {
						suggestedClusterUrl = first ? String(first.clusterUrl || '') : '';
						suggestedDatabase = first ? String(first.database || '') : '';
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			if (singleKind === 'markdown') {
				// IMPORTANT: pass text via options so addMarkdownBox can stash it before
				// initializing the TOAST UI editor (which triggers an immediate schedulePersist).
				const isPlainMd = String(pState.documentKind || '') === 'md';
				// Initialize the compat text tracker so the first schedulePersist
				// after restore recognizes the baseline and only sends persistDocument
				// when the user actually edits the text (not just unrelated metadata).
				try { __kustoLastCompatQueryText = singleText; } catch (e) { console.error('[kusto]', e); }
				addMarkdownBox({ text: singleText, mdAutoExpand: isPlainMd });
				return;
			}
			const boxId = addQueryBox();
			// Apply optional suggested cluster/db selection for compatibility-mode query docs.
			try {
				const desiredClusterUrl = String(suggestedClusterUrl || '').trim();
				const db = String(suggestedDatabase || '').trim();
				const kwEl = __kustoGetQuerySectionElement(boxId);
				if (kwEl) {
					if (desiredClusterUrl && typeof kwEl.setDesiredClusterUrl === 'function') {
						kwEl.setDesiredClusterUrl(desiredClusterUrl);
					}
					if (db && typeof kwEl.setDesiredDatabase === 'function') {
						kwEl.setDesiredDatabase(db);
					}
				}
				// If this suggested selection exists in favorites, switch to Favorites mode by default.
				try {
					if (desiredClusterUrl && db) {
						__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
					}
				} catch (e) { console.error('[kusto]', e); }
				// Ensure dropdowns see the desired selection once connections/favorites are available.
				try { updateConnectionSelects(); } catch (e) { console.error('[kusto]', e); }
				try {
					__kustoTryAutoEnterFavoritesModeForAllBoxes();
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			try {
				pState.pendingQueryTextByBoxId[boxId] = singleText;
			} catch (e) { console.error('[kusto]', e); }
			// Initialize the compat query text tracker so the first schedulePersist
			// after restore recognizes the baseline and only sends persistDocument
			// when the user actually edits the query text (not just cluster/database).
			try { __kustoLastCompatQueryText = singleText; } catch (e) { console.error('[kusto]', e); }
			return;
		}

		const sections = Array.isArray(s.sections) ? s.sections : [];
		const normalizeClusterUrlKey = (url: any) => {
			try {
				const raw = String(url || '').trim();
				if (!raw) return '';
				const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
				const u = new URL(withScheme);
				// Lowercase host, drop trailing slashes.
				const out = (u.origin + u.pathname).replace(/\/+$/, '');
				return out.toLowerCase();
			} catch {
				return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
			}
		};
		const clusterShortNameKey = (url: any) => {
			try {
				const raw = String(url || '').trim();
				if (!raw) return '';
				const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
				const u = new URL(withScheme);
				const host = String(u.hostname || '').trim();
				const first = host ? host.split('.')[0] : '';
				return String(first || host || raw).trim().toLowerCase();
			} catch {
				return String(url || '').trim().toLowerCase();
			}
		};
		const findConnectionIdByClusterUrl = (clusterUrl: any) => {
			try {
				const key = normalizeClusterUrlKey(clusterUrl);
				if (!key) return '';
				for (const c of (connections || [])) {
					if (!c) continue;
					const ck = normalizeClusterUrlKey(c.clusterUrl || '');
					if (ck && ck === key) {
						return String(c.id || '');
					}
				}
				// Fallback: match by short-name key.
				const sk = clusterShortNameKey(clusterUrl);
				if (sk) {
					for (const c of (connections || [])) {
						if (!c) continue;
						const ck2 = clusterShortNameKey(c.clusterUrl || '');
						if (ck2 && ck2 === sk) {
							return String(c.id || '');
						}
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			return '';
		};
		for (const section of sections) {
			const t = section && section.type ? String(section.type) : '';
			if (t === 'devnotes') {
				// Dev notes are hidden — store as passthrough, no DOM element
				try {
					pState.devNotesSections = pState.devNotesSections || [];
					pState.devNotesSections.push(section);
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}
			if (t === 'query' || t === 'copilotQuery') {
				const isLegacyCopilotQuerySection = t === 'copilotQuery';
				const boxId = addQueryBox({
					id: (section.id ? String(section.id) : undefined),
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					clusterUrl: String(section.clusterUrl || ''),
					database: String(section.database || '')
				});
				try {
					__kustoSetSectionName(boxId, String(section.name || ''));
				} catch (e) { console.error('[kusto]', e); }
				try {
					const desiredClusterUrl = String(section.clusterUrl || '');
					const resolvedConnectionId = desiredClusterUrl ? findConnectionIdByClusterUrl(desiredClusterUrl) : '';
					const db = String(section.database || '');
					const kwEl = __kustoGetQuerySectionElement(boxId);
					// If this saved selection exists in favorites, switch to Favorites mode by default.
					try {
						if (desiredClusterUrl && db) {
							__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
						}
					} catch (e) { console.error('[kusto]', e); }
					if (kwEl) {
						if (db && typeof kwEl.setDesiredDatabase === 'function') {
							kwEl.setDesiredDatabase(db);
						}
						if (desiredClusterUrl && typeof kwEl.setDesiredClusterUrl === 'function') {
							kwEl.setDesiredClusterUrl(desiredClusterUrl);
						}
						if (resolvedConnectionId && typeof kwEl.setConnectionId === 'function') {
							kwEl.setConnectionId(resolvedConnectionId);
							// Trigger database field load for this connection.
							try {
								kwEl.dispatchEvent(new CustomEvent('connection-changed', {
									detail: { boxId: boxId, connectionId: resolvedConnectionId, clusterUrl: desiredClusterUrl },
									bubbles: true, composed: true,
								}));
							} catch (e) { console.error('[kusto]', e); }
						} else {
							// Try again after connections are populated.
							try { updateConnectionSelects(); } catch (e) { console.error('[kusto]', e); }
						}
					}
					try {
						__kustoTryAutoEnterFavoritesModeForAllBoxes();
					} catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				// Restore explicit favorites-mode UI state (if present). This is important for
				// upgrade/reload flows where boxes are recreated and would otherwise default back
				// to cluster/database pickers.
				try {
					if (typeof section.favoritesMode === 'boolean') {
						if (typeof (_win.__kustoSetFavoritesModeForBox) === 'function') {
							_win.__kustoSetFavoritesModeForBox(boxId, !!section.favoritesMode);
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					pState.pendingQueryTextByBoxId[boxId] = String(section.query || '');
				} catch (e) { console.error('[kusto]', e); }
				// Restore per-query results visibility BEFORE displaying results,
				// so displayResult sees the hidden state when creating kw-data-table.
				try {
					if (typeof section.resultsVisible === 'boolean') {
						pState.resultsVisibleByBoxId[boxId] = !!section.resultsVisible;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Restore last result (if present + parseable).
				try {
					const rj = section.resultJson ? String(section.resultJson) : '';
					if (rj) {
						// Keep in-memory cache aligned with restored boxes.
						pState.queryResultJsonByBoxId[boxId] = rj;
						try {
							const parsed = JSON.parse(rj);
							if (parsed && typeof parsed === 'object') {
								// displayResult expects columns/rows/metadata in the typical shape.
								const p = parsed;
								if (!p.metadata || typeof p.metadata !== 'object') {
									p.metadata = { executionTime: '' };
								} else if (typeof p.metadata.executionTime === 'undefined') {
									p.metadata.executionTime = '';
								}
								pState.lastExecutedBox = boxId;
								displayResult(p);
							}
						} catch {
							// If stored JSON is invalid, drop it.
							delete pState.queryResultJsonByBoxId[boxId];
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					setRunMode(boxId, String(section.runMode || 'take100'));
				} catch (e) { console.error('[kusto]', e); }
				try {
					const ce = document.getElementById(boxId + '_cache_enabled');
					const cv = document.getElementById(boxId + '_cache_value');
					const cu = document.getElementById(boxId + '_cache_unit');
					if (ce) (ce as any).checked = (section.cacheEnabled !== false);
					if (cv) (cv as any).value = String(section.cacheValue || 1);
					if (cu) (cu as any).value = String(section.cacheUnit || 'days');
					try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				// Apply results visibility UI (toggle button + legacy results wrapper).
				try {
					if (typeof section.resultsVisible === 'boolean') {
						try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
						try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				// Copilot chat always starts closed — visibility is not restored from persisted state.
				try {
					if (typeof section.copilotChatWidthPx === 'number') {
						const kwEl = __kustoGetQuerySectionElement(boxId);
						if (kwEl && typeof kwEl.setCopilotChatWidthPx === 'function') {
							kwEl.setCopilotChatWidthPx(section.copilotChatWidthPx);
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Monaco editor may initialize after restore; remember desired wrapper height for initQueryEditor.
				try {
					if (typeof section.editorHeightPx === 'number' && Number.isFinite(section.editorHeightPx) && section.editorHeightPx > 0) {
						pState.pendingWrapperHeightPxByBoxId[boxId] = section.editorHeightPx;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Apply persisted heights after any Copilot chat installation/reparenting.
				try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch (e) { console.error('[kusto]', e); }
				try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch (e) { console.error('[kusto]', e); }
				// Re-apply on next tick to avoid any late layout/resize observers overriding restored sizes.
				try {
					setTimeout(() => {
						try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch (e) { console.error('[kusto]', e); }
						try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch (e) { console.error('[kusto]', e); }
						try {
const editor = (queryEditors && queryEditors[boxId]) ? queryEditors[boxId] : null;
							if (editor && typeof editor.layout === 'function') {
								editor.layout();
							}
						} catch (e) { console.error('[kusto]', e); }
					}, 0);
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'chart') {
				const boxId = addChartBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					mode: (typeof section.mode === 'string') ? String(section.mode) : 'edit',
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					editorHeightPx: (typeof section.editorHeightPx === 'number') ? section.editorHeightPx : undefined,
					dataSourceId: (typeof section.dataSourceId === 'string') ? section.dataSourceId : undefined,
					chartType: (typeof section.chartType === 'string') ? section.chartType : undefined,
					xColumn: (typeof section.xColumn === 'string') ? section.xColumn : undefined,
					yColumns: (Array.isArray(section.yColumns) ? section.yColumns : undefined),
					tooltipColumns: (Array.isArray(section.tooltipColumns) ? section.tooltipColumns : undefined),
					yColumn: (typeof section.yColumn === 'string') ? section.yColumn : undefined,
					legendColumn: (typeof section.legendColumn === 'string') ? section.legendColumn : undefined,
					legendPosition: (typeof section.legendPosition === 'string') ? section.legendPosition : undefined,
					labelColumn: (typeof section.labelColumn === 'string') ? section.labelColumn : undefined,
					valueColumn: (typeof section.valueColumn === 'string') ? section.valueColumn : undefined,
					showDataLabels: (typeof section.showDataLabels === 'boolean') ? section.showDataLabels : false,
					sortColumn: (typeof section.sortColumn === 'string') ? section.sortColumn : undefined,
					sortDirection: (typeof section.sortDirection === 'string') ? section.sortDirection : undefined,
					xAxisSettings: (section.xAxisSettings && typeof section.xAxisSettings === 'object') ? section.xAxisSettings : undefined,
					yAxisSettings: (section.yAxisSettings && typeof section.yAxisSettings === 'object') ? section.yAxisSettings : undefined
				});
				try {
					// Ensure buttons/UI reflect persisted state.
					if (typeof _win.__kustoApplyChartMode === 'function') {
						_win.__kustoApplyChartMode(boxId);
					}
					if (typeof _win.__kustoApplyChartBoxVisibility === 'function') {
						_win.__kustoApplyChartBoxVisibility(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'transformation') {
				let deriveColumns = undefined;
				try {
					if (Array.isArray(section.deriveColumns)) {
						deriveColumns = section.deriveColumns
							.filter((c: any) => c && typeof c === 'object')
							.map((c: any) => ({
								name: (typeof c.name === 'string') ? c.name : String((c.name ?? '') || ''),
								expression: (typeof c.expression === 'string') ? c.expression : String((c.expression ?? '') || '')
							}));
					} else {
						// Back-compat: migrate single-field derive into array.
						const legacyName = (typeof section.deriveColumnName === 'string') ? section.deriveColumnName : '';
						const legacyExpr = (typeof section.deriveExpression === 'string') ? section.deriveExpression : '';
						if (legacyName || legacyExpr) {
							deriveColumns = [{ name: legacyName || 'derived', expression: legacyExpr || '' }];
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				let aggregations;
				try {
					if (Array.isArray(section.aggregations)) {
						aggregations = section.aggregations
							.filter((a: any) => a && typeof a === 'object')
							.map((a: any) => ({
								name: (typeof a.name === 'string') ? a.name : String((a.name ?? '') || ''),
								function: (typeof a.function === 'string') ? a.function : String((a.function ?? '') || ''),
								column: (typeof a.column === 'string') ? a.column : String((a.column ?? '') || '')
							}));
					}
				} catch (e) { console.error('[kusto]', e); }
				const boxId = addTransformationBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					mode: (typeof section.mode === 'string') ? String(section.mode) : 'edit',
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					editorHeightPx: (typeof section.editorHeightPx === 'number') ? section.editorHeightPx : undefined,
					dataSourceId: (typeof section.dataSourceId === 'string') ? section.dataSourceId : undefined,
					transformationType: (typeof section.transformationType === 'string') ? section.transformationType : undefined,
					distinctColumn: (typeof section.distinctColumn === 'string') ? section.distinctColumn : undefined,
					deriveColumns,
					groupByColumns: (Array.isArray(section.groupByColumns) ? section.groupByColumns : undefined),
					aggregations: aggregations,
					pivotRowKeyColumn: (typeof section.pivotRowKeyColumn === 'string') ? section.pivotRowKeyColumn : undefined,
					pivotColumnKeyColumn: (typeof section.pivotColumnKeyColumn === 'string') ? section.pivotColumnKeyColumn : undefined,
					pivotValueColumn: (typeof section.pivotValueColumn === 'string') ? section.pivotValueColumn : undefined,
					pivotAggregation: (typeof section.pivotAggregation === 'string') ? section.pivotAggregation : undefined,
					pivotMaxColumns: (typeof section.pivotMaxColumns === 'number') ? section.pivotMaxColumns : undefined
				});
				continue;
			}

			if (t === 'markdown') {
				let mode = '';
				try {
					const m = String(section.mode || '').toLowerCase();
					if (m === 'preview' || m === 'markdown' || m === 'wysiwyg') {
						mode = m;
					}
				} catch (e) { console.error('[kusto]', e); }
				// Back-compat: if this .kqlx uses the older `tab` field, treat preview tab as Preview mode.
				if (!mode) {
					try {
						const tab = String(section.tab || '').toLowerCase();
						if (tab === 'preview') {
							mode = 'preview';
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				const boxId = addMarkdownBox({
					id: (section.id ? String(section.id) : undefined),
					text: String(section.text || ''),
					editorHeightPx: section.editorHeightPx,
					...(mode ? { mode } : {})
				});
				// Apply title and expanded state on the Lit element.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).setTitle === 'function') {
						(el as any).setTitle(String(section.title || ''));
						(el as any).setExpanded(section.expanded !== false);
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'python') {
				// Store pending code so the Lit component can pick it up during Monaco init.
				const pendingId = section.id ? String(section.id) : ('python_' + Date.now());
				try {
					pState.pendingPythonCodeByBoxId[pendingId] = String(section.code || '');
				} catch (e) { console.error('[kusto]', e); }
				const boxId = addPythonBox({ id: pendingId });
				// Set output, name, expanded, and height on the Lit element.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).setOutput === 'function') {
						(el as any).setOutput(String(section.output || ''));
					}
					if (el && typeof (el as any).setTitle === 'function' && section.name) {
						(el as any).setTitle(String(section.name));
					}
					if (el && typeof (el as any).setExpanded === 'function' && typeof section.expanded === 'boolean') {
						(el as any).setExpanded(section.expanded);
					}
					if (el && section.editorHeightPx) {
						el.setAttribute('editor-height-px', String(section.editorHeightPx));
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}

			if (t === 'url') {
				const boxId = addUrlBox({
					id: (section.id ? String(section.id) : undefined),
					name: String(section.name || ''),
					url: String(section.url || ''),
					expanded: !!section.expanded,
					outputHeightPx: section.outputHeightPx,
					imageSizeMode: section.imageSizeMode,
					imageAlign: section.imageAlign,
					imageOverflow: section.imageOverflow
				});
				// The Lit element handles its own state; just trigger fetch if expanded.
				try {
					const el = document.getElementById(boxId);
					if (el && typeof (el as any).triggerFetch === 'function') {
						(el as any).triggerFetch();
					}
				} catch (e) { console.error('[kusto]', e); }
				continue;
			}
		}
	} finally {
		pState.restoreInProgress = false;
		__kustoPersistenceEnabled = true;
		// Do not auto-persist immediately after restore: Monaco editors may not be ready yet,
		// and persisting too early can overwrite loaded content with empty strings.
	}
}

function __kustoApplyPendingAdds() {
	const pendingAdds = (pState.queryEditorPendingAdds && typeof (pState.queryEditorPendingAdds) === 'object')
		? pState.queryEditorPendingAdds
		: { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
	// Reset counts so they don't replay on reload.
	pState.queryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };

	const pendingTotal =
		(pendingAdds.query || 0) +
		(pendingAdds.chart || 0) +
		(pendingAdds.transformation || 0) +
		(pendingAdds.markdown || 0) +
		(pendingAdds.python || 0) +
		(pendingAdds.url || 0);
	if (pendingTotal <= 0) {
		return false;
	}
	const allowed = Array.isArray(pState.allowedSectionKinds)
		? pState.allowedSectionKinds.map((v: any) => String(v))
		: ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];
	if (allowed.includes('query')) {
		for (let i = 0; i < (pendingAdds.query || 0); i++) addQueryBox();
	}
	if (allowed.includes('chart')) {
		for (let i = 0; i < (pendingAdds.chart || 0); i++) addChartBox();
	}
	if (allowed.includes('transformation')) {
		for (let i = 0; i < (pendingAdds.transformation || 0); i++) addTransformationBox();
	}
	if (allowed.includes('markdown')) {
		for (let i = 0; i < (pendingAdds.markdown || 0); i++) addMarkdownBox();
	}
	if (allowed.includes('python')) {
		for (let i = 0; i < (pendingAdds.python || 0); i++) addPythonBox();
	}
	if (allowed.includes('url')) {
		for (let i = 0; i < (pendingAdds.url || 0); i++) addUrlBox();
	}
	return true;
}

export function handleDocumentDataMessage(message: any) {
	__kustoDocumentDataApplyCount++;

	// The extension host should only send documentData in response to requestDocument.
	// If we receive it more than once, re-applying causes noticeable flicker and can leave
	// Monaco editors in a bad interactive state due to teardown/recreate races.
	// So by default, only apply the first documentData payload, unless either:
	// - forceReload is requested, or
	// - the payload is for a different documentUri (preview tab reuse scenario).
	try {
		const incomingDocumentUri = (message && typeof message.documentUri === 'string') ? String(message.documentUri) : '';
		const isDifferentDocument = !!incomingDocumentUri && !!__kustoLastAppliedDocumentUri && incomingDocumentUri !== __kustoLastAppliedDocumentUri;
		if (__kustoHasAppliedDocument && !(message && message.forceReload) && !isDifferentDocument) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	__kustoHasAppliedDocument = true;
	try {
		if (message && typeof message.documentUri === 'string') {
			__kustoLastAppliedDocumentUri = String(message.documentUri);
		}
	} catch (e) { console.error('[kusto]', e); }

	// Some host-to-webview messages can arrive before the webview registers its message listener.
	// documentData is requested by the webview after initialization, so it is a reliable place
	// to apply compatibility mode for .kql/.csl files.
	try {
		if (typeof message.compatibilityMode === 'boolean') {
			if (typeof __kustoSetCompatibilityMode === 'function') {
				__kustoSetCompatibilityMode(!!message.compatibilityMode);
			} else {
				pState.compatibilityMode = !!message.compatibilityMode;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Capabilities can arrive either via persistenceMode or (for robustness) piggybacked on documentData.
	// This prevents restore issues when messages arrive out-of-order.
	try {
		if (typeof message.documentUri === 'string') {
			pState.documentUri = String(message.documentUri);
		}
		if (Array.isArray(message.allowedSectionKinds)) {
			pState.allowedSectionKinds = message.allowedSectionKinds.map((k: any) => String(k));
		}
		if (typeof message.documentKind === 'string') {
			pState.documentKind = String(message.documentKind);
			try {
				if (document && document.body && document.body.dataset) {
					document.body.dataset.kustoDocumentKind = String(message.documentKind);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
		if (typeof message.defaultSectionKind === 'string') {
			pState.defaultSectionKind = String(message.defaultSectionKind);
		}
		if (typeof message.compatibilitySingleKind === 'string') {
			pState.compatibilitySingleKind = String(message.compatibilitySingleKind);
		}
		if (typeof message.upgradeRequestType === 'string') {
			pState.upgradeRequestType = String(message.upgradeRequestType);
		}
		if (typeof message.compatibilityTooltip === 'string') {
			pState.compatibilityTooltip = String(message.compatibilityTooltip);
		}
		try {
			if (typeof __kustoApplyDocumentCapabilities === 'function') {
				__kustoApplyDocumentCapabilities();
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }

	const ok = !!(message && message.ok);
	if (!ok && message && message.error) {
		try {
			// Non-fatal: start with an empty doc state.
			console.warn('Failed to parse .kqlx:', message.error);
		} catch (e) { console.error('[kusto]', e); }
	}

	applyKqlxState(message && message.state ? message.state : { sections: [] });

	// If the doc is empty, initialize UX content.
	try {
		const hasAny = (queryBoxes && queryBoxes.length) || (markdownBoxes && markdownBoxes.length) || (pythonBoxes && pythonBoxes.length) || (urlBoxes && urlBoxes.length);
		if (!hasAny) {
			const applied = __kustoApplyPendingAdds();
			if (!applied) {
				const k = String(pState.defaultSectionKind || 'query');
				if (k === 'markdown') {
					addMarkdownBox();
				} else {
					addQueryBox();
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// ── Schema diagnostics: log all sections on file open ──
	try {
		const allBoxIds: string[] = Array.isArray(queryBoxes) ? queryBoxes : [];
		const sectionSummary = allBoxIds.map((bid: string) => {
			const el = document.getElementById(bid) as any;
			if (!el || typeof el.getConnectionId !== 'function') return null;
			const connId = el.getConnectionId();
			const db = el.getDatabase();
			const cluster = el.getClusterUrl ? el.getClusterUrl() : '';
			const name = el.getName ? el.getName() : bid;
			return { boxId: bid, name, cluster: cluster || '(none)', database: db || '(none)', connectionId: connId || '(none)' };
		}).filter(Boolean);
		console.log('%c[schema-diag] FILE OPENED — sections:', 'color:#0af;font-weight:bold', sectionSummary);
	} catch (e) { console.error('[schema-diag]', e); }

	// Update monaco-kusto schema for the FIRST visible/expanded Kusto section only
	// Monaco-kusto can only have ONE schema in context at a time, so we only load for the first box.
	// When user clicks on another box, that box's schema will be loaded via __kustoUpdateSchemaForFocusedBox.
	try {
		setTimeout(() => {
			try {
				if (typeof queryBoxes !== 'undefined' && Array.isArray(queryBoxes)) {
					for (const boxId of queryBoxes) {
						// Check if this box is expanded (visible)
						let expanded = true;
						try {
							expanded = !(_win.__kustoQueryExpandedByBoxId && _win.__kustoQueryExpandedByBoxId[boxId] === false);
						} catch (e) { console.error('[kusto]', e); }
						if (expanded && typeof __kustoUpdateSchemaForFocusedBox === 'function') {
							// Only request schema for the first expanded box, then break
							__kustoUpdateSchemaForFocusedBox(boxId);
							break;
						}
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}, 100); // Small delay to ensure editors are mounted
	} catch (e) { console.error('[kusto]', e); }

	// Persistence remains enabled; edits will persist via event hooks.
}

// ======================================================================
// Window bridge: expose globals for remaining legacy callers
// ======================================================================
_win.schedulePersist = schedulePersist; // inline HTML onclick consumers

