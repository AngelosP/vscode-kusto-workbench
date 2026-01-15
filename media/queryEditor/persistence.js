// Persistence + .kqlx document round-tripping.
//
// The extension host stores the state as JSON in a .kqlx file.
// This file provides:
// - export: collect the current UI state
// - restore: rebuild the UI from a state object
// - debounced write-through: postMessage({type:'persistDocument'})

let __kustoPersistenceEnabled = false;
let __kustoRestoreInProgress = false;
let __kustoPersistTimer = null;
let __kustoDocumentDataApplyCount = 0;
let __kustoHasAppliedDocument = false;
// Set by the extension host; true for globalStorage/session.kqlx.
window.__kustoIsSessionFile = false;
// Set by the extension host; true for .kql/.csl files.
window.__kustoCompatibilityMode = false;

// Document capabilities (set by extension host via the persistenceMode message).
// - allowedSectionKinds controls which add buttons are shown/enabled.
// - defaultSectionKind controls which section we create for an empty document.
// - upgradeRequestType controls which message we send when in compatibility mode.
window.__kustoAllowedSectionKinds = window.__kustoAllowedSectionKinds || ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];
window.__kustoDefaultSectionKind = window.__kustoDefaultSectionKind || 'query';
window.__kustoCompatibilitySingleKind = window.__kustoCompatibilitySingleKind || 'query';
window.__kustoUpgradeRequestType = window.__kustoUpgradeRequestType || 'requestUpgradeToKqlx';
window.__kustoCompatibilityTooltip = window.__kustoCompatibilityTooltip || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.';
window.__kustoDocumentKind = window.__kustoDocumentKind || '';

function __kustoApplyDocumentCapabilities() {
	try {
		const allowed = Array.isArray(window.__kustoAllowedSectionKinds)
			? window.__kustoAllowedSectionKinds.map(k => String(k))
			: ['query', 'markdown', 'python', 'url'];
		const btns = document.querySelectorAll('.add-controls .add-control-btn');
		for (const btn of btns) {
			try {
				const kind = btn && btn.getAttribute ? String(btn.getAttribute('data-add-kind') || '') : '';
				const wrapper = btn && btn.parentElement ? btn.parentElement : null;
				const visible = !kind || allowed.includes(kind);
				if (wrapper) {
					wrapper.style.display = visible ? '' : 'none';
				} else {
					btn.style.display = visible ? '' : 'none';
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function __kustoSetCompatibilityMode(enabled) {
	try {
		window.__kustoCompatibilityMode = !!enabled;
		const msg = String(window.__kustoCompatibilityTooltip || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.');
		const wrappers = document.querySelectorAll('.add-controls .add-control-wrapper');
		for (const w of wrappers) {
			try {
				if (enabled) {
					w.title = msg;
				} else if (w.title === msg) {
					w.title = '';
				}
			} catch {
				// ignore
			}
		}
		const buttons = document.querySelectorAll('.add-controls .add-control-btn');
		for (const btn of buttons) {
			try {
				// Keep enabled; clicking will offer to upgrade.
				btn.disabled = false;
				btn.setAttribute('aria-disabled', 'false');
				// Tooltip is on wrapper span.
				btn.title = '';
			} catch {
				// ignore
			}
		}

		// Apply visibility of add buttons based on allowed kinds.
		try { __kustoApplyDocumentCapabilities(); } catch { /* ignore */ }

		// If we just entered compatibility mode, ensure any early queued add clicks don't
		// accidentally create extra sections that can't be persisted.
		if (enabled) {
			try {
				if (window.__kustoQueryEditorPendingAdds && typeof window.__kustoQueryEditorPendingAdds === 'object') {
					window.__kustoQueryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function __kustoRequestAddSection(kind) {
	const k = String(kind || '').trim();
	if (!k) return;

	// Respect allowed section kinds.
	try {
		const allowed = Array.isArray(window.__kustoAllowedSectionKinds)
			? window.__kustoAllowedSectionKinds.map(v => String(v))
			: ['query', 'chart', 'markdown', 'python', 'url'];
		if (allowed.length > 0 && !allowed.includes(k)) {
			return;
		}
	} catch {
		// ignore
	}

	// For .kql/.csl compatibility files: offer upgrade instead of adding sections.
	try {
		if (window.__kustoCompatibilityMode) {
			try {
				const upgradeType = String(window.__kustoUpgradeRequestType || 'requestUpgradeToKqlx');
				vscode.postMessage({ type: upgradeType, addKind: k });
			} catch {
				// ignore
			}
			return;
		}
	} catch {
		// ignore
	}

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
	window.__kustoRequestAddSection = __kustoRequestAddSection;
} catch {
	// ignore
}

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
window.__kustoPendingQueryTextByBoxId = window.__kustoPendingQueryTextByBoxId || {};
window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
window.__kustoPendingPythonCodeByBoxId = window.__kustoPendingPythonCodeByBoxId || {};

// Optional persisted query results (per box), stored as JSON text.
// This stays in-memory and is included in getKqlxState.
window.__kustoQueryResultJsonByBoxId = window.__kustoQueryResultJsonByBoxId || {};

// Persisted query results are stored inline in the .kqlx document.
// Keep a cap to avoid ballooning the file, but try hard to keep *some* results
// (e.g. truncate rows) instead of dropping them entirely.
//
// Note: this is per-query-box, and the document can contain multiple boxes.
// We intentionally allow several MB because session.kqlx lives in extension global storage.
const __kustoMaxPersistedResultBytes = 5 * 1024 * 1024;
const __kustoMaxPersistedResultRowsHardCap = 5000;

function __kustoByteLengthUtf8(text) {
	try {
		if (typeof TextEncoder !== 'undefined') {
			return new TextEncoder().encode(String(text)).length;
		}
		// Fallback: approximate (UTF-16 code units). Safe enough for a cap.
		return String(text).length * 2;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function __kustoTryStoreQueryResult(boxId, result) {
	try {
		if (!boxId) return;
		let json = '';
		try {
			json = JSON.stringify(result ?? null);
		} catch {
			// If result isn't serializable, don't persist it.
			delete window.__kustoQueryResultJsonByBoxId[boxId];
			return;
		}
		let bytes = __kustoByteLengthUtf8(json);
		if (bytes <= __kustoMaxPersistedResultBytes) {
			window.__kustoQueryResultJsonByBoxId[boxId] = json;
			return;
		}

		// Too large: attempt to persist a truncated version (keep columns + metadata + top N rows).
		try {
			const cols = Array.isArray(result && result.columns) ? result.columns : [];
			const rows = Array.isArray(result && result.rows) ? result.rows : [];
			const meta = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};

			// If there are no rows to trim, give up.
			if (!rows || !Array.isArray(rows) || rows.length === 0) {
				delete window.__kustoQueryResultJsonByBoxId[boxId];
				return;
			}

			const totalRows = rows.length;
			let hi = Math.min(totalRows, __kustoMaxPersistedResultRowsHardCap);
			let lo = 0;
			let bestJson = '';
			let bestCount = 0;

			// Binary search the largest row count that fits.
			while (lo <= hi) {
				const mid = Math.floor((lo + hi) / 2);
				const candidate = {
					columns: cols,
					rows: rows.slice(0, mid),
					metadata: Object.assign({}, meta, {
						persistedTruncated: true,
						persistedTotalRows: totalRows,
						persistedRows: mid
					})
				};
				let candidateJson = '';
				try {
					candidateJson = JSON.stringify(candidate);
				} catch {
					candidateJson = '';
				}
				const candidateBytes = candidateJson ? __kustoByteLengthUtf8(candidateJson) : Number.MAX_SAFE_INTEGER;
				if (candidateJson && candidateBytes <= __kustoMaxPersistedResultBytes) {
					bestJson = candidateJson;
					bestCount = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}

			if (bestJson && bestCount > 0) {
				window.__kustoQueryResultJsonByBoxId[boxId] = bestJson;
				return;
			}
		} catch {
			// ignore
		}

		// Still too large; do not persist.
		delete window.__kustoQueryResultJsonByBoxId[boxId];
	} catch {
		// ignore
	}
}

// Called by main.js when query results arrive.
function __kustoOnQueryResult(boxId, result) {
	__kustoTryStoreQueryResult(boxId, result);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoFindQueryEditorWrapper(boxId, suffix) {
	try {
		const el = document.getElementById(boxId + suffix);
		let wrapper = (el && el.closest) ? el.closest('.query-editor-wrapper') : null;
		if (!wrapper) {
			const box = document.getElementById(boxId);
			wrapper = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
		}
		return wrapper;
	} catch {
		return null;
	}
}

function __kustoGetWrapperHeightPx(boxId, suffix) {
	try {
		// If the user manually resized, prefer the explicit height state.
		try {
			const map = window.__kustoManualQueryEditorHeightPxByBoxId;
			const v = map ? map[boxId] : undefined;
			if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
				return Math.max(0, Math.round(v));
			}
		} catch { /* ignore */ }

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
		} catch { /* ignore */ }
		// Prefer the explicit user-resize marker, but accept any non-auto inline height.
		return Math.max(0, px);
	} catch {
		return undefined;
	}
}

function __kustoSetWrapperHeightPx(boxId, suffix, heightPx) {
	try {
		const wrapper = __kustoFindQueryEditorWrapper(boxId, suffix);
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		wrapper.style.height = Math.round(h) + 'px';
		try {
			wrapper.dataset.kustoUserResized = 'true';
		} catch {
			// ignore
		}
		try {
			const editor = (window.queryEditors && window.queryEditors[boxId]) ? window.queryEditors[boxId] : null;
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoGetUrlOutputHeightPx(boxId) {
	try {
		const wrapper = document.getElementById(boxId + '_wrapper');
		if (!wrapper) return undefined;
		// Only persist heights that came from an explicit user resize (or a restored persisted height).
		// Auto/default layout can vary and should not mark the document dirty.
		try {
			if (!wrapper.dataset || wrapper.dataset.kustoUserResized !== 'true') {
				return undefined;
			}
		} catch {
			return undefined;
		}
		let inlineHeight = (wrapper.style && typeof wrapper.style.height === 'string') ? wrapper.style.height.trim() : '';
		// When URL CSV results are hidden we may collapse the wrapper to height:auto, but we still
		// want to persist the user's last explicit height.
		if (!inlineHeight || inlineHeight === 'auto') {
			try {
				const prev = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight).trim() : '';
				if (prev) {
					inlineHeight = prev;
				}
			} catch {
				// ignore
			}
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

function __kustoSetUrlOutputHeightPx(boxId, heightPx) {
	try {
		const wrapper = document.getElementById(boxId + '_wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		// Keep within the same bounds as the URL drag-resize affordance.
		const clamped = Math.max(120, Math.min(900, Math.round(h)));
		wrapper.style.height = clamped + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		// If the persisted height is larger than a rendered table's contents, clamp it once
		// the DOM has finished laying out.
		try {
			setTimeout(() => {
				try {
					if (typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
						window.__kustoClampUrlCsvWrapperHeight(boxId);
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoGetQueryResultsOutputHeightPx(boxId) {
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
		// If results were temporarily collapsed to auto, keep the user's last explicit height.
		if (!inlineHeight || inlineHeight === 'auto') {
			try {
				const prev = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight).trim() : '';
				if (prev) {
					inlineHeight = prev;
				}
			} catch {
				// ignore
			}
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

function __kustoSetQueryResultsOutputHeightPx(boxId, heightPx) {
	try {
		const wrapper = document.getElementById(boxId + '_results_wrapper');
		if (!wrapper) return;
		const h = Number(heightPx);
		if (!Number.isFinite(h) || h <= 0) return;
		// Query results resizer bounds use ~900px max; keep persisted restore within that.
		const clamped = Math.max(120, Math.min(900, Math.round(h)));
		wrapper.style.height = clamped + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		// If this section currently has short non-table content (errors, etc.), clamp on next tick.
		try {
			setTimeout(() => {
				try {
					if (typeof window.__kustoClampResultsWrapperHeight === 'function') {
						window.__kustoClampResultsWrapperHeight(boxId);
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function getKqlxState() {
	// Compatibility mode (.kql/.csl/.md): only a single section is supported.
	try {
		if (window.__kustoCompatibilityMode) {
			const singleKind = String(window.__kustoCompatibilitySingleKind || 'query');
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
				} catch { /* ignore */ }
				let text = '';
				try {
					text = (firstMarkdownBoxId && markdownEditors && markdownEditors[firstMarkdownBoxId])
						? (markdownEditors[firstMarkdownBoxId].getValue() || '')
						: '';
				} catch { /* ignore */ }
				if (!text) {
					try {
						const pending = window.__kustoPendingMarkdownTextByBoxId && firstMarkdownBoxId
							? window.__kustoPendingMarkdownTextByBoxId[firstMarkdownBoxId]
							: undefined;
						if (typeof pending === 'string') {
							text = pending;
						}
					} catch { /* ignore */ }
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
			} catch { /* ignore */ }
			const q = (firstQueryBoxId && queryEditors && queryEditors[firstQueryBoxId])
				? (queryEditors[firstQueryBoxId].getValue() || '')
				: '';
			return {
				caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
				autoTriggerAutocompleteEnabled: (typeof autoTriggerAutocompleteEnabled === 'boolean') ? autoTriggerAutocompleteEnabled : false,
				sections: [{ type: 'query', query: q }]
			};
		}
	} catch {
		// ignore
	}

	const sections = [];
	const container = document.getElementById('queries-container');
	const children = container ? Array.from(container.children || []) : [];
	for (const child of children) {
		const id = child && child.id ? String(child.id) : '';
		if (!id) continue;

		if (id.startsWith('query_')) {
			const querySectionType = 'query';
			const name = (document.getElementById(id + '_name') || {}).value || '';
			const connectionId = (document.getElementById(id + '_connection') || {}).value || '';
			let expanded = true;
			try {
				expanded = !(window.__kustoQueryExpandedByBoxId && window.__kustoQueryExpandedByBoxId[id] === false);
			} catch { /* ignore */ }
			let resultsVisible = true;
			try {
				resultsVisible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[id] === false);
			} catch { /* ignore */ }
			let clusterUrl = '';
			try {
				if (connectionId && Array.isArray(connections)) {
					const conn = (connections || []).find(c => c && String(c.id || '') === String(connectionId));
					clusterUrl = conn ? String(conn.clusterUrl || '') : '';
				}
			} catch {
				// ignore
			}
			const database = (document.getElementById(id + '_database') || {}).value || '';
			const query = queryEditors && queryEditors[id] ? (queryEditors[id].getValue() || '') : '';
			const resultJson = (window.__kustoQueryResultJsonByBoxId && window.__kustoQueryResultJsonByBoxId[id])
				? String(window.__kustoQueryResultJsonByBoxId[id])
				: '';
			const runMode = (runModesByBoxId && runModesByBoxId[id]) ? String(runModesByBoxId[id]) : 'take100';
			const cacheEnabled = !!((document.getElementById(id + '_cache_enabled') || {}).checked);
			const cacheValue = parseInt(((document.getElementById(id + '_cache_value') || {}).value || '1'), 10) || 1;
			const cacheUnit = (document.getElementById(id + '_cache_unit') || {}).value || 'days';
			let copilotChatVisible;
			let copilotChatWidthPx;
			try {
				if (typeof window.__kustoGetCopilotChatVisible === 'function') {
					copilotChatVisible = !!window.__kustoGetCopilotChatVisible(id);
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoGetCopilotChatWidthPx === 'function') {
					const w = window.__kustoGetCopilotChatWidthPx(id);
					if (typeof w === 'number' && Number.isFinite(w)) {
						copilotChatWidthPx = w;
					}
				}
			} catch { /* ignore */ }
			sections.push({
				id,
				type: querySectionType,
				name,
				clusterUrl,
				database,
				query,
				expanded,
				resultsVisible,
				...(resultJson ? { resultJson } : {}),
				runMode,
				cacheEnabled,
				cacheValue,
				cacheUnit,
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_query_editor'),
				resultsHeightPx: __kustoGetQueryResultsOutputHeightPx(id),
				...(typeof copilotChatVisible === 'boolean' ? { copilotChatVisible } : {}),
				...(typeof copilotChatWidthPx === 'number' ? { copilotChatWidthPx } : {})
			});
			continue;
		}

		if (id.startsWith('chart_')) {
			const name = (document.getElementById(id + '_name') || {}).value || '';
			let mode = 'edit';
			let expanded = true;
			let dataSourceId = '';
			let chartType = '';
			let xColumn = '';
			let yColumn = '';
			let yColumns = [];
			let legendColumn = '';
			let labelColumn = '';
			let valueColumn = '';
			let showDataLabels = false;
			try {
				const st = (typeof chartStateByBoxId === 'object' && chartStateByBoxId && chartStateByBoxId[id]) ? chartStateByBoxId[id] : null;
				const m = st && st.mode ? String(st.mode).toLowerCase() : 'edit';
				if (m === 'preview' || m === 'edit') {
					mode = m;
				}
				expanded = (st && typeof st.expanded === 'boolean') ? !!st.expanded : true;
				dataSourceId = (st && typeof st.dataSourceId === 'string') ? String(st.dataSourceId) : '';
				chartType = (st && typeof st.chartType === 'string') ? String(st.chartType) : '';
				xColumn = (st && typeof st.xColumn === 'string') ? String(st.xColumn) : '';
				yColumn = (st && typeof st.yColumn === 'string') ? String(st.yColumn) : '';
				yColumns = (st && Array.isArray(st.yColumns)) ? st.yColumns.filter(c => c) : [];
				legendColumn = (st && typeof st.legendColumn === 'string') ? String(st.legendColumn) : '';
				labelColumn = (st && typeof st.labelColumn === 'string') ? String(st.labelColumn) : '';
				valueColumn = (st && typeof st.valueColumn === 'string') ? String(st.valueColumn) : '';
				showDataLabels = (st && typeof st.showDataLabels === 'boolean') ? !!st.showDataLabels : false;
			} catch { /* ignore */ }
			sections.push({
				id,
				type: 'chart',
				name,
				mode,
				expanded,
				...(dataSourceId ? { dataSourceId } : {}),
				...(chartType ? { chartType } : {}),
				...(xColumn ? { xColumn } : {}),
				...(yColumn ? { yColumn } : {}),
				...(yColumns.length ? { yColumns } : {}),
				...(legendColumn ? { legendColumn } : {}),
				...(labelColumn ? { labelColumn } : {}),
				...(valueColumn ? { valueColumn } : {}),
				...(showDataLabels ? { showDataLabels } : {}),
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_chart_wrapper')
			});
			continue;
		}

		if (id.startsWith('transformation_')) {
			const name = (document.getElementById(id + '_name') || {}).value || '';
			let mode = 'edit';
			let expanded = true;
			let dataSourceId = '';
			let transformationType = '';
			let distinctColumn = '';
			let deriveColumns = [];
			let deriveColumnName = '';
			let deriveExpression = '';
			let groupByColumns = [];
			let aggregations = [];
			let pivotRowKeyColumn = '';
			let pivotColumnKeyColumn = '';
			let pivotValueColumn = '';
			let pivotAggregation = '';
			let pivotMaxColumns;
			try {
				const st = (typeof transformationStateByBoxId === 'object' && transformationStateByBoxId && transformationStateByBoxId[id]) ? transformationStateByBoxId[id] : null;
				const m = st && st.mode ? String(st.mode).toLowerCase() : 'edit';
				if (m === 'preview' || m === 'edit') {
					mode = m;
				}
				expanded = (st && typeof st.expanded === 'boolean') ? !!st.expanded : true;
				dataSourceId = (st && typeof st.dataSourceId === 'string') ? String(st.dataSourceId) : '';
				transformationType = (st && typeof st.transformationType === 'string') ? String(st.transformationType) : '';
				distinctColumn = (st && typeof st.distinctColumn === 'string') ? String(st.distinctColumn) : '';
				deriveColumns = (st && Array.isArray(st.deriveColumns))
					? st.deriveColumns
						.filter(c => c && typeof c === 'object')
						.map(c => ({
							name: (typeof c.name === 'string') ? c.name : String((c.name ?? '') || ''),
							expression: (typeof c.expression === 'string') ? c.expression : String((c.expression ?? '') || '')
						}))
					: [];
				// Back-compat: older in-memory state may still use single fields.
				deriveColumnName = (st && typeof st.deriveColumnName === 'string') ? String(st.deriveColumnName) : '';
				deriveExpression = (st && typeof st.deriveExpression === 'string') ? String(st.deriveExpression) : '';
				groupByColumns = (st && Array.isArray(st.groupByColumns)) ? st.groupByColumns.filter(c => c) : [];
				aggregations = (st && Array.isArray(st.aggregations))
					? st.aggregations
						.filter(a => a && typeof a === 'object')
						.map(a => ({
							name: (typeof a.name === 'string') ? a.name : String((a.name ?? '') || ''),
							function: (typeof a.function === 'string') ? a.function : String((a.function ?? '') || ''),
							column: (typeof a.column === 'string') ? a.column : String((a.column ?? '') || '')
						}))
					: [];
				pivotRowKeyColumn = (st && typeof st.pivotRowKeyColumn === 'string') ? String(st.pivotRowKeyColumn) : '';
				pivotColumnKeyColumn = (st && typeof st.pivotColumnKeyColumn === 'string') ? String(st.pivotColumnKeyColumn) : '';
				pivotValueColumn = (st && typeof st.pivotValueColumn === 'string') ? String(st.pivotValueColumn) : '';
				pivotAggregation = (st && typeof st.pivotAggregation === 'string') ? String(st.pivotAggregation) : '';
				if (st && typeof st.pivotMaxColumns === 'number' && Number.isFinite(st.pivotMaxColumns)) {
					pivotMaxColumns = st.pivotMaxColumns;
				}
			} catch { /* ignore */ }
			// If deriveColumns is missing but legacy single-field derive data exists, serialize it.
			try {
				if ((!deriveColumns || !Array.isArray(deriveColumns) || deriveColumns.length === 0) && (deriveColumnName || deriveExpression)) {
					deriveColumns = [{ name: deriveColumnName || 'derived', expression: deriveExpression || '' }];
				}
			} catch { /* ignore */ }

			sections.push({
				id,
				type: 'transformation',
				name,
				mode,
				expanded,
				...(dataSourceId ? { dataSourceId } : {}),
				...(transformationType ? { transformationType } : {}),
				...(distinctColumn ? { distinctColumn } : {}),
				...(Array.isArray(deriveColumns) && deriveColumns.length ? { deriveColumns } : {}),
				...(groupByColumns.length ? { groupByColumns } : {}),
				...(aggregations.length ? { aggregations } : {}),
				...(pivotRowKeyColumn ? { pivotRowKeyColumn } : {}),
				...(pivotColumnKeyColumn ? { pivotColumnKeyColumn } : {}),
				...(pivotValueColumn ? { pivotValueColumn } : {}),
				...(pivotAggregation ? { pivotAggregation } : {}),
				...(typeof pivotMaxColumns === 'number' ? { pivotMaxColumns } : {}),
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_tf_wrapper')
			});
			continue;
		}

		if (id.startsWith('markdown_')) {
			const title = (document.getElementById(id + '_name') || {}).value || '';
			let text = '';
			try {
				text = markdownEditors && markdownEditors[id] ? (markdownEditors[id].getValue() || '') : '';
			} catch { /* ignore */ }
			// If the editor hasn't initialized yet (e.g. TOAST UI still loading), don't lose content:
			// use the pending restore buffer.
			if (!text) {
				try {
					const pending = window.__kustoPendingMarkdownTextByBoxId && window.__kustoPendingMarkdownTextByBoxId[id];
					if (typeof pending === 'string' && pending) {
						text = pending;
					}
				} catch { /* ignore */ }
			}
			let mode = '';
			try {
				const m = (window.__kustoMarkdownModeByBoxId && typeof window.__kustoMarkdownModeByBoxId === 'object')
					? String(window.__kustoMarkdownModeByBoxId[id] || '').toLowerCase()
					: '';
				if (m === 'preview' || m === 'markdown' || m === 'wysiwyg') {
					mode = m;
				}
			} catch { /* ignore */ }
			const tab = (mode === 'preview') ? 'preview' : 'edit';
			let expanded = true;
			try {
				expanded = !(window.__kustoMarkdownExpandedByBoxId && window.__kustoMarkdownExpandedByBoxId[id] === false);
			} catch { /* ignore */ }
			let editorHeightPx = __kustoGetWrapperHeightPx(id, '_md_editor');
			// If we're currently in Preview we may temporarily clear inline height; keep the last px height if present.
			if (typeof editorHeightPx === 'undefined') {
				try {
					const host = document.getElementById(id + '_md_editor');
					const wrapper = host && host.closest ? host.closest('.query-editor-wrapper') : null;
					const prev = (wrapper && wrapper.dataset && wrapper.dataset.kustoPrevHeightMd) ? String(wrapper.dataset.kustoPrevHeightMd || '').trim() : '';
					const m = prev.match(/^([0-9]+)px$/i);
					if (m) {
						const px = parseInt(m[1], 10);
						if (Number.isFinite(px)) {
							editorHeightPx = Math.max(0, px);
						}
					}
				} catch { /* ignore */ }
			}
			sections.push({
				id,
				type: 'markdown',
				title,
				text,
				tab,
				...(mode ? { mode } : {}),
				expanded,
				editorHeightPx
			});
			continue;
		}

		if (id.startsWith('python_')) {
			const code = pythonEditors && pythonEditors[id] ? (pythonEditors[id].getValue() || '') : '';
			const output = (document.getElementById(id + '_py_output') || {}).textContent || '';
			sections.push({
				id,
				type: 'python',
				code,
				output,
				editorHeightPx: __kustoGetWrapperHeightPx(id, '_py_editor')
			});
			continue;
		}

		if (id.startsWith('url_')) {
			const st = (urlStateByBoxId && urlStateByBoxId[id]) ? urlStateByBoxId[id] : null;
			const name = (document.getElementById(id + '_name') || {}).value || '';
			const url = st ? (String(st.url || '')) : ((document.getElementById(id + '_input') || {}).value || '');
			const expanded = !!(st && st.expanded);
			sections.push({
				id,
				type: 'url',
				name,
				url,
				expanded,
				outputHeightPx: __kustoGetUrlOutputHeightPx(id)
			});
			continue;
		}
	}

	return {
		caretDocsEnabled: (typeof caretDocsEnabled === 'boolean') ? caretDocsEnabled : true,
		autoTriggerAutocompleteEnabled: (typeof autoTriggerAutocompleteEnabled === 'boolean') ? autoTriggerAutocompleteEnabled : false,
		sections
	};
}

var __kustoLastPersistSignature = '';

function schedulePersist(reason) {
	if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
		return;
	}
	try {
		if (__kustoPersistTimer) {
			clearTimeout(__kustoPersistTimer);
		}
		const r = (typeof reason === 'string' && reason) ? reason : '';
		__kustoPersistTimer = setTimeout(() => {
			try {
				const state = getKqlxState();
				let sig = '';
				try { sig = JSON.stringify(state); } catch { sig = ''; }
				if (sig && sig === __kustoLastPersistSignature) {
					return;
				}
				if (sig) {
					__kustoLastPersistSignature = sig;
				}
				vscode.postMessage({ type: 'persistDocument', state, reason: r });
			} catch {
				// ignore
			}
		}, 400);
	} catch {
		// ignore
	}
}

// Best-effort flush: when the user closes the editor, try to persist the latest state immediately.
// (The extension decides whether to actually auto-save to disk; for session.kqlx it does.)
try {
	window.addEventListener('beforeunload', () => {
		try {
			// Only force a final flush for the session file.
			if (!window.__kustoIsSessionFile) {
				return;
			}
			if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
				return;
			}
			const state = getKqlxState();
			vscode.postMessage({ type: 'persistDocument', state, flush: true, reason: 'flush' });
		} catch {
			// ignore
		}
	});
} catch {
	// ignore
}

function __kustoClearAllSections() {
	try {
		for (const id of (queryBoxes || []).slice()) {
			try { removeQueryBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (chartBoxes || []).slice()) {
			try { removeChartBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (markdownBoxes || []).slice()) {
			try { removeMarkdownBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (pythonBoxes || []).slice()) {
			try { removePythonBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of (urlBoxes || []).slice()) {
			try { removeUrlBox(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function applyKqlxState(state) {
	__kustoRestoreInProgress = true;
	try {
		__kustoPersistenceEnabled = false;

		// Reset persisted results when loading a new document.
		try { window.__kustoQueryResultJsonByBoxId = {}; } catch { /* ignore */ }

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };

		// Respect a global user preference (persisted in extension globalState) once it exists.
		// Only fall back to document state if the user has never explicitly toggled the feature.
		const userSet = (() => {
			try {
				return !!window.__kustoCaretDocsEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!userSet && typeof s.caretDocsEnabled === 'boolean') {
			caretDocsEnabled = !!s.caretDocsEnabled;
			try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
		}

		const autoUserSet = (() => {
			try {
				return !!window.__kustoAutoTriggerAutocompleteEnabledUserSet;
			} catch {
				return false;
			}
		})();
		if (!autoUserSet && typeof s.autoTriggerAutocompleteEnabled === 'boolean') {
			autoTriggerAutocompleteEnabled = !!s.autoTriggerAutocompleteEnabled;
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch { /* ignore */ }
		}

		// Compatibility mode (single-section plain text files): force exactly one editor and ignore all other sections.
		if (window.__kustoCompatibilityMode) {
			const singleKind = String(window.__kustoCompatibilitySingleKind || 'query');
			let singleText = '';
			let suggestedClusterUrl = '';
			let suggestedDatabase = '';
			try {
				const sections = Array.isArray(s.sections) ? s.sections : [];
				const first = sections.find(sec => sec && String(sec.type || '') === singleKind);
				if (singleKind === 'markdown') {
					singleText = first ? String(first.text || '') : '';
				} else {
					singleText = first ? String(first.query || '') : '';
					// Optional: extension host can provide a best-effort suggested selection for .kql/.csl.
					try {
						suggestedClusterUrl = first ? String(first.clusterUrl || '') : '';
						suggestedDatabase = first ? String(first.database || '') : '';
					} catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
			if (singleKind === 'markdown') {
				// IMPORTANT: pass text via options so addMarkdownBox can stash it before
				// initializing the TOAST UI editor (which triggers an immediate schedulePersist).
				const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
				addMarkdownBox({ text: singleText, mdAutoExpand: isPlainMd });
				return;
			}
			const boxId = addQueryBox();
			// Apply optional suggested cluster/db selection for compatibility-mode query docs.
			try {
				const desiredClusterUrl = String(suggestedClusterUrl || '').trim();
				const db = String(suggestedDatabase || '').trim();
				const connEl = document.getElementById(boxId + '_connection');
				const dbEl = document.getElementById(boxId + '_database');
				if (desiredClusterUrl && connEl && connEl.dataset) {
					connEl.dataset.desiredClusterUrl = desiredClusterUrl;
					// addQueryBox() calls updateConnectionSelects() immediately and may have
					// auto-filled lastConnectionId already. Clear it so the desired selection
					// can win on the next updateConnectionSelects() run.
					try { connEl.value = ''; } catch { /* ignore */ }
					try { delete connEl.dataset.prevValue; } catch { /* ignore */ }
				}
				if (db && dbEl && dbEl.dataset) {
					dbEl.dataset.desired = db;
					// Optimistic prefill (matches .kqlx restore behavior) so the user sees the intended DB immediately.
					try {
						const esc = (typeof escapeHtml === 'function') ? escapeHtml(db) : db;
						dbEl.innerHTML =
							'<option value="" disabled hidden>Select Database...</option>' +
							'<option value="' + esc + '">' + esc + '</option>';
						dbEl.value = db;
					} catch { /* ignore */ }
				}
				// If this suggested selection exists in favorites, switch to Favorites mode by default.
				try {
					if (desiredClusterUrl && db && typeof window.__kustoSetAutoEnterFavoritesForBox === 'function') {
						window.__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
					}
				} catch { /* ignore */ }
				// Ensure dropdowns see the desired selection once connections/favorites are available.
				try { updateConnectionSelects(); } catch { /* ignore */ }
				try {
					if (typeof window.__kustoTryAutoEnterFavoritesModeForAllBoxes === 'function') {
						window.__kustoTryAutoEnterFavoritesModeForAllBoxes();
					}
				} catch { /* ignore */ }
			} catch {
				// ignore
			}
			try {
				window.__kustoPendingQueryTextByBoxId[boxId] = singleText;
			} catch {
				// ignore
			}
			return;
		}

		const sections = Array.isArray(s.sections) ? s.sections : [];
		const normalizeClusterUrlKey = (url) => {
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
		const clusterShortNameKey = (url) => {
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
		const findConnectionIdByClusterUrl = (clusterUrl) => {
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
			} catch {
				// ignore
			}
			return '';
		};
		for (const section of sections) {
			const t = section && section.type ? String(section.type) : '';
			if (t === 'query' || t === 'copilotQuery') {
				const isLegacyCopilotQuerySection = t === 'copilotQuery';
				const boxId = addQueryBox({
					id: (section.id ? String(section.id) : undefined),
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true
				});
				try {
					const nameEl = document.getElementById(boxId + '_name');
					if (nameEl) nameEl.value = String(section.name || '');
				} catch { /* ignore */ }
				try {
					const desiredClusterUrl = String(section.clusterUrl || '');
					const resolvedConnectionId = desiredClusterUrl ? findConnectionIdByClusterUrl(desiredClusterUrl) : '';
					const db = String(section.database || '');
					const connEl = document.getElementById(boxId + '_connection');
					const dbEl = document.getElementById(boxId + '_database');
					// If this saved selection exists in favorites, switch to Favorites mode by default.
					try {
						if (desiredClusterUrl && db && typeof window.__kustoSetAutoEnterFavoritesForBox === 'function') {
							window.__kustoSetAutoEnterFavoritesForBox(boxId, desiredClusterUrl, db);
						}
					} catch { /* ignore */ }
					if (dbEl) {
						dbEl.dataset.desired = db;
						// Optimistic restore: show the persisted DB immediately, even before the DB list loads.
						if (db) {
							const esc = (typeof escapeHtml === 'function') ? escapeHtml(db) : db;
							dbEl.innerHTML =
								'<option value="" disabled hidden>Select Database...</option>' +
								'<option value="' + esc + '">' + esc + '</option>';
							dbEl.value = db;
						}
					}
					if (connEl) {
						// Stash desired selection so updateConnectionSelects can apply it once
						// connections are populated (connections may arrive after document restore).
						if (desiredClusterUrl) {
							connEl.dataset.desiredClusterUrl = desiredClusterUrl;
						}

						if (resolvedConnectionId) {
							connEl.value = resolvedConnectionId;
							connEl.dataset.prevValue = resolvedConnectionId;
							updateDatabaseField(boxId);
						} else {
							// Try again after connections are populated.
							try { updateConnectionSelects(); } catch { /* ignore */ }
						}
					}
					try {
						if (typeof window.__kustoTryAutoEnterFavoritesModeForAllBoxes === 'function') {
							window.__kustoTryAutoEnterFavoritesModeForAllBoxes();
						}
					} catch { /* ignore */ }
				} catch { /* ignore */ }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					window.__kustoPendingQueryTextByBoxId[boxId] = String(section.query || '');
				} catch { /* ignore */ }
				// Restore last result (if present + parseable).
				try {
					const rj = section.resultJson ? String(section.resultJson) : '';
					if (rj) {
						// Keep in-memory cache aligned with restored boxes.
						window.__kustoQueryResultJsonByBoxId[boxId] = rj;
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
								window.lastExecutedBox = boxId;
								if (typeof displayResult === 'function') {
									displayResult(p);
								}
							}
						} catch {
							// If stored JSON is invalid, drop it.
							delete window.__kustoQueryResultJsonByBoxId[boxId];
						}
					}
				} catch { /* ignore */ }
				try {
					setRunMode(boxId, String(section.runMode || 'take100'));
				} catch { /* ignore */ }
				try {
					const ce = document.getElementById(boxId + '_cache_enabled');
					const cv = document.getElementById(boxId + '_cache_value');
					const cu = document.getElementById(boxId + '_cache_unit');
					if (ce) ce.checked = (section.cacheEnabled !== false);
					if (cv) cv.value = String(section.cacheValue || 1);
					if (cu) cu.value = String(section.cacheUnit || 'days');
					try { toggleCacheControls(boxId); } catch { /* ignore */ }
				} catch { /* ignore */ }
				// Restore per-query results visibility (show/hide results toggle).
				try {
					if (typeof section.resultsVisible === 'boolean') {
						if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
							window.__kustoResultsVisibleByBoxId = {};
						}
						window.__kustoResultsVisibleByBoxId[boxId] = !!section.resultsVisible;
						try { __kustoUpdateQueryResultsToggleButton && __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
						try { __kustoApplyResultsVisibility && __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
				try {
					let desiredVisible;
					if (typeof section.copilotChatVisible === 'boolean') {
						desiredVisible = !!section.copilotChatVisible;
					} else if (isLegacyCopilotQuerySection) {
						// Back-compat: legacy copilotQuery sections always had the chat shown.
						desiredVisible = true;
					}
					if (typeof desiredVisible === 'boolean' && typeof window.__kustoSetCopilotChatVisible === 'function') {
						window.__kustoSetCopilotChatVisible(boxId, desiredVisible);
					}
				} catch { /* ignore */ }
				try {
					if (typeof window.__kustoSetCopilotChatWidthPx === 'function' && typeof section.copilotChatWidthPx === 'number') {
						window.__kustoSetCopilotChatWidthPx(boxId, section.copilotChatWidthPx);
					}
				} catch { /* ignore */ }
				// Monaco editor may initialize after restore; remember desired wrapper height for initQueryEditor.
				try {
					if (typeof section.editorHeightPx === 'number' && Number.isFinite(section.editorHeightPx) && section.editorHeightPx > 0) {
						if (!window.__kustoPendingWrapperHeightPxByBoxId) window.__kustoPendingWrapperHeightPxByBoxId = {};
						window.__kustoPendingWrapperHeightPxByBoxId[boxId] = section.editorHeightPx;
					}
				} catch { /* ignore */ }
				// Apply persisted heights after any Copilot chat installation/reparenting.
				try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch { /* ignore */ }
				try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch { /* ignore */ }
				// Re-apply on next tick to avoid any late layout/resize observers overriding restored sizes.
				try {
					setTimeout(() => {
						try { __kustoSetWrapperHeightPx(boxId, '_query_editor', section.editorHeightPx); } catch { /* ignore */ }
						try { __kustoSetQueryResultsOutputHeightPx(boxId, section.resultsHeightPx); } catch { /* ignore */ }
						try {
							const editor = (window.queryEditors && window.queryEditors[boxId]) ? window.queryEditors[boxId] : null;
							if (editor && typeof editor.layout === 'function') {
								editor.layout();
							}
						} catch { /* ignore */ }
					}, 0);
				} catch { /* ignore */ }
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
					yColumn: (typeof section.yColumn === 'string') ? section.yColumn : undefined,
					legendColumn: (typeof section.legendColumn === 'string') ? section.legendColumn : undefined,
					labelColumn: (typeof section.labelColumn === 'string') ? section.labelColumn : undefined,
					valueColumn: (typeof section.valueColumn === 'string') ? section.valueColumn : undefined,
					showDataLabels: (typeof section.showDataLabels === 'boolean') ? section.showDataLabels : false
				});
				try {
					// Ensure buttons/UI reflect persisted state.
					if (typeof __kustoApplyChartMode === 'function') {
						__kustoApplyChartMode(boxId);
					}
					if (typeof __kustoApplyChartBoxVisibility === 'function') {
						__kustoApplyChartBoxVisibility(boxId);
					}
				} catch { /* ignore */ }
				continue;
			}

			if (t === 'transformation') {
				let deriveColumns = undefined;
				try {
					if (Array.isArray(section.deriveColumns)) {
						deriveColumns = section.deriveColumns
							.filter(c => c && typeof c === 'object')
							.map(c => ({
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
				} catch { /* ignore */ }
				let aggregations;
				try {
					if (Array.isArray(section.aggregations)) {
						aggregations = section.aggregations
							.filter(a => a && typeof a === 'object')
							.map(a => ({
								name: (typeof a.name === 'string') ? a.name : String((a.name ?? '') || ''),
								function: (typeof a.function === 'string') ? a.function : String((a.function ?? '') || ''),
								column: (typeof a.column === 'string') ? a.column : String((a.column ?? '') || '')
							}));
					}
				} catch { /* ignore */ }
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
				try {
					if (typeof __kustoApplyTransformationMode === 'function') {
						__kustoApplyTransformationMode(boxId);
					}
					if (typeof __kustoApplyTransformationBoxVisibility === 'function') {
						__kustoApplyTransformationBoxVisibility(boxId);
					}
				} catch { /* ignore */ }
				continue;
			}

			if (t === 'markdown') {
				let mode = '';
				try {
					const m = String(section.mode || '').toLowerCase();
					if (m === 'preview' || m === 'markdown' || m === 'wysiwyg') {
						mode = m;
					}
				} catch { /* ignore */ }
				// Back-compat: if this .kqlx uses the older `tab` field, treat preview tab as Preview mode.
				if (!mode) {
					try {
						const tab = String(section.tab || '').toLowerCase();
						if (tab === 'preview') {
							mode = 'preview';
						}
					} catch { /* ignore */ }
				}
				const boxId = addMarkdownBox({
					id: (section.id ? String(section.id) : undefined),
					text: String(section.text || ''),
					editorHeightPx: section.editorHeightPx,
					...(mode ? { mode } : {})
				});
				try {
					const titleEl = document.getElementById(boxId + '_name');
					if (titleEl) titleEl.value = String(section.title || '');
				} catch { /* ignore */ }
				try {
					if (!window.__kustoMarkdownExpandedByBoxId || typeof window.__kustoMarkdownExpandedByBoxId !== 'object') {
						window.__kustoMarkdownExpandedByBoxId = {};
					}
					window.__kustoMarkdownExpandedByBoxId[boxId] = (section.expanded !== false);
				} catch { /* ignore */ }
				try { __kustoUpdateMarkdownVisibilityToggleButton(boxId); } catch { /* ignore */ }
				try { __kustoApplyMarkdownBoxVisibility(boxId); } catch { /* ignore */ }
				continue;
			}

			if (t === 'python') {
				const boxId = addPythonBox({ id: (section.id ? String(section.id) : undefined) });
				// Monaco editor may not exist yet; store pending python code for initPythonEditor.
				try {
					window.__kustoPendingPythonCodeByBoxId[boxId] = String(section.code || '');
				} catch { /* ignore */ }
				try { setPythonOutput(boxId, String(section.output || '')); } catch { /* ignore */ }
				try { __kustoSetWrapperHeightPx(boxId, '_py_editor', section.editorHeightPx); } catch { /* ignore */ }
				continue;
			}

			if (t === 'url') {
				const boxId = addUrlBox({ id: (section.id ? String(section.id) : undefined) });
				try {
					const name = String(section.name || '');
					const nameInput = document.getElementById(boxId + '_name');
					if (nameInput) nameInput.value = name;
					try {
						if (typeof onUrlNameInput === 'function') {
							onUrlNameInput(boxId);
						}
					} catch { /* ignore */ }
				} catch { /* ignore */ }
				try {
					const url = String(section.url || '');
					const expanded = !!section.expanded;
					const input = document.getElementById(boxId + '_input');
					if (input) input.value = url;
					if (!urlStateByBoxId[boxId]) {
						urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
					}
					urlStateByBoxId[boxId].url = url;
					urlStateByBoxId[boxId].expanded = expanded;
					urlStateByBoxId[boxId].loaded = false;
					urlStateByBoxId[boxId].content = '';
					urlStateByBoxId[boxId].error = '';
					urlStateByBoxId[boxId].kind = '';
					urlStateByBoxId[boxId].contentType = '';
					urlStateByBoxId[boxId].status = null;
					urlStateByBoxId[boxId].dataUri = '';
					urlStateByBoxId[boxId].body = '';
					urlStateByBoxId[boxId].truncated = false;
					try { __kustoSetUrlOutputHeightPx(boxId, section.outputHeightPx); } catch { /* ignore */ }
					try {
						if (typeof __kustoUpdateUrlToggleButton === 'function') {
							__kustoUpdateUrlToggleButton(boxId);
						}
					} catch { /* ignore */ }
					updateUrlContent(boxId);
					// On open/restore: if the section is visible, automatically fetch its content.
					try {
						if (expanded && url && typeof requestUrlContent === 'function') {
							requestUrlContent(boxId);
						}
					} catch { /* ignore */ }
				} catch { /* ignore */ }
				continue;
			}
		}
	} finally {
		__kustoRestoreInProgress = false;
		__kustoPersistenceEnabled = true;
		// Do not auto-persist immediately after restore: Monaco editors may not be ready yet,
		// and persisting too early can overwrite loaded content with empty strings.
	}
}

function __kustoApplyPendingAdds() {
	const pendingAdds = (window.__kustoQueryEditorPendingAdds && typeof window.__kustoQueryEditorPendingAdds === 'object')
		? window.__kustoQueryEditorPendingAdds
		: { query: 0, markdown: 0, python: 0, url: 0 };
	// Reset counts so they don't replay on reload.
	window.__kustoQueryEditorPendingAdds = { query: 0, markdown: 0, python: 0, url: 0 };

	const pendingTotal = (pendingAdds.query || 0) + (pendingAdds.markdown || 0) + (pendingAdds.python || 0) + (pendingAdds.url || 0);
	if (pendingTotal <= 0) {
		return false;
	}
	const allowed = Array.isArray(window.__kustoAllowedSectionKinds)
		? window.__kustoAllowedSectionKinds.map(v => String(v))
		: ['query', 'markdown', 'python', 'url'];
	if (allowed.includes('query')) {
		for (let i = 0; i < (pendingAdds.query || 0); i++) addQueryBox();
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

function handleDocumentDataMessage(message) {
	__kustoDocumentDataApplyCount++;

	// The extension host should only send documentData in response to requestDocument.
	// If we receive it more than once, re-applying causes noticeable flicker and can leave
	// Monaco editors in a bad interactive state due to teardown/recreate races.
	// So by default, only apply the first documentData payload.
	try {
		if (__kustoHasAppliedDocument && !(message && message.forceReload)) {
			return;
		}
	} catch {
		// ignore
	}
	__kustoHasAppliedDocument = true;

	// Some host-to-webview messages can arrive before the webview registers its message listener.
	// documentData is requested by the webview after initialization, so it is a reliable place
	// to apply compatibility mode for .kql/.csl files.
	try {
		if (typeof message.compatibilityMode === 'boolean') {
			if (typeof __kustoSetCompatibilityMode === 'function') {
				__kustoSetCompatibilityMode(!!message.compatibilityMode);
			} else {
				window.__kustoCompatibilityMode = !!message.compatibilityMode;
			}
		}
	} catch {
		// ignore
	}

	// Capabilities can arrive either via persistenceMode or (for robustness) piggybacked on documentData.
	// This prevents restore issues when messages arrive out-of-order.
	try {
		if (typeof message.documentUri === 'string') {
			window.__kustoDocumentUri = String(message.documentUri);
		}
		if (Array.isArray(message.allowedSectionKinds)) {
			window.__kustoAllowedSectionKinds = message.allowedSectionKinds.map(k => String(k));
		}
		if (typeof message.documentKind === 'string') {
			window.__kustoDocumentKind = String(message.documentKind);
			try {
				if (document && document.body && document.body.dataset) {
					document.body.dataset.kustoDocumentKind = String(message.documentKind);
				}
			} catch { /* ignore */ }
		}
		if (typeof message.defaultSectionKind === 'string') {
			window.__kustoDefaultSectionKind = String(message.defaultSectionKind);
		}
		if (typeof message.compatibilitySingleKind === 'string') {
			window.__kustoCompatibilitySingleKind = String(message.compatibilitySingleKind);
		}
		if (typeof message.upgradeRequestType === 'string') {
			window.__kustoUpgradeRequestType = String(message.upgradeRequestType);
		}
		if (typeof message.compatibilityTooltip === 'string') {
			window.__kustoCompatibilityTooltip = String(message.compatibilityTooltip);
		}
		try {
			if (typeof __kustoApplyDocumentCapabilities === 'function') {
				__kustoApplyDocumentCapabilities();
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}

	const ok = !!(message && message.ok);
	if (!ok && message && message.error) {
		try {
			// Non-fatal: start with an empty doc state.
			console.warn('Failed to parse .kqlx:', message.error);
		} catch {
			// ignore
		}
	}

	applyKqlxState(message && message.state ? message.state : { sections: [] });

	// If the doc is empty, initialize UX content.
	try {
		const hasAny = (queryBoxes && queryBoxes.length) || (markdownBoxes && markdownBoxes.length) || (pythonBoxes && pythonBoxes.length) || (urlBoxes && urlBoxes.length);
		if (!hasAny) {
			const applied = __kustoApplyPendingAdds();
			if (!applied) {
				const k = String(window.__kustoDefaultSectionKind || 'query');
				if (k === 'markdown') {
					addMarkdownBox();
				} else {
					addQueryBox();
				}
			}
		}
	} catch {
		// ignore
	}

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
							expanded = !(window.__kustoQueryExpandedByBoxId && window.__kustoQueryExpandedByBoxId[boxId] === false);
						} catch { /* ignore */ }
						if (expanded && typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
							// Only request schema for the first expanded box, then break
							window.__kustoUpdateSchemaForFocusedBox(boxId);
							break;
						}
					}
				}
			} catch { /* ignore */ }
		}, 100); // Small delay to ensure editors are mounted
	} catch {
		// ignore
	}

	// Persistence remains enabled; edits will persist via event hooks.
}
