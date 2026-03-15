// Persistence module — converted from legacy/persistence.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window;
// Persistence + .kqlx document round-tripping.
//
// The extension host stores the state as JSON in a .kqlx file.
// This file provides:
// - export: collect the current UI state
// - restore: rebuild the UI from a state object
// - debounced write-through: postMessage({type:'persistDocument'})

let __kustoPersistenceEnabled = false;
let __kustoRestoreInProgress = false;
let __kustoPersistTimer: any = null;
let __kustoDocumentDataApplyCount = 0;
let __kustoHasAppliedDocument = false;
let __kustoLastAppliedDocumentUri = '';
// Set by the extension host; true for globalStorage/session.kqlx.
if ((_win.__kustoIsSessionFile as any) === undefined) _win.__kustoIsSessionFile = false;
// Set by the extension host; true for .kql/.csl files.
if ((_win.__kustoCompatibilityMode as any) === undefined) _win.__kustoCompatibilityMode = false;

/**
 * Helper to normalize a cluster URL for consistent comparison.
 */
function __kustoNormalizeClusterUrl(clusterUrl: any) {
	try {
		let u = String(clusterUrl || '').trim();
		if (!u) return '';
		if (!/^https?:\/\//i.test(u)) {
			u = 'https://' + u;
		}
		return u.replace(/\/+$/g, '').toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Check if a cluster URL is marked as "Leave no trace".
 * When true, tabular results from this cluster should not be persisted.
 */
function __kustoIsLeaveNoTraceCluster(clusterUrl: any) {
	try {
		if (!clusterUrl) return false;
		// (_win.leaveNoTraceClusters as any) is defined in state.js and populated from connectionsData
		if (typeof (_win.leaveNoTraceClusters as any) === 'undefined' || !Array.isArray((_win.leaveNoTraceClusters as any))) return false;
		const normalized = __kustoNormalizeClusterUrl(clusterUrl);
		if (!normalized) return false;
		return (_win.leaveNoTraceClusters as any).some(function(lntUrl: any) {
			return __kustoNormalizeClusterUrl(lntUrl) === normalized;
		});
	} catch {
		return false;
	}
}

// Document capabilities (set by extension host via the persistenceMode message).
// - allowedSectionKinds controls which add buttons are shown/enabled.
// - defaultSectionKind controls which section we create for an empty document.
// - upgradeRequestType controls which message we send when in compatibility mode.
_win.__kustoAllowedSectionKinds = (_win.__kustoAllowedSectionKinds as any) || ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];
_win.__kustoDefaultSectionKind = (_win.__kustoDefaultSectionKind as any) || 'query';
_win.__kustoCompatibilitySingleKind = (_win.__kustoCompatibilitySingleKind as any) || 'query';
_win.__kustoUpgradeRequestType = (_win.__kustoUpgradeRequestType as any) || 'requestUpgradeToKqlx';
_win.__kustoCompatibilityTooltip = (_win.__kustoCompatibilityTooltip as any) || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.';
_win.__kustoDocumentKind = (_win.__kustoDocumentKind as any) || '';

function __kustoApplyDocumentCapabilities() {
	try {
		const allowed = Array.isArray((_win.__kustoAllowedSectionKinds as any))
			? (_win.__kustoAllowedSectionKinds as any).map((k: any) => String(k))
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
			} catch {
				// ignore
			}
		}

		// Update dropdown items visibility (for narrow viewport dropdown)
		const dropdownItems = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of dropdownItems as any) {
			try {
				const kind = item.getAttribute ? String(item.getAttribute('data-add-kind') || '') : '';
				const visible = !kind || allowed.includes(kind);
				item.style.display = visible ? '' : 'none';
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function __kustoSetCompatibilityMode(enabled: any) {
	try {
		_win.__kustoCompatibilityMode = !!enabled;
		const msg = String((_win.__kustoCompatibilityTooltip as any) || 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.');
		const wrappers = document.querySelectorAll('.add-controls .add-control-wrapper');
		for (const w of wrappers as any) {
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
		for (const btn of buttons as any) {
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
				if ((_win.__kustoQueryEditorPendingAdds as any) && typeof (_win.__kustoQueryEditorPendingAdds) === 'object') {
					_win.__kustoQueryEditorPendingAdds = { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 };
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function __kustoRequestAddSection(kind: any) {
	const k = String(kind || '').trim();
	if (!k) return;

	// Respect allowed section kinds.
	try {
		const allowed = Array.isArray((_win.__kustoAllowedSectionKinds as any))
			? (_win.__kustoAllowedSectionKinds as any).map((v: any) => String(v))
			: ['query', 'chart', 'markdown', 'python', 'url'];
		if (allowed.length > 0 && !allowed.includes(k)) {
			return;
		}
	} catch {
		// ignore
	}

	// For .kql/.csl compatibility files: offer upgrade instead of adding sections.
	try {
		if ((_win.__kustoCompatibilityMode as any)) {
			try {
				// IMPORTANT: results persistence is debounced; if the user clicks "add chart" right
				// after executing, the current resultJson may not have been sent to the extension yet.
				// So capture the current state and send it along with the upgrade request.
				const upgradeType = String((_win.__kustoUpgradeRequestType as any) || 'requestUpgradeToKqlx');
				let state = null;
				try {
					if (typeof getKqlxState === 'function') {
						state = getKqlxState();
					}
				} catch { /* ignore */ }
				// Best-effort immediate persist so the extension has the latest state even if it
				// doesn't look at the upgrade payload (or if ordering differs).
				try {
					if (state) {
						(_win.vscode as any).postMessage({ type: 'persistDocument', state, reason: 'upgrade' });
					}
				} catch { /* ignore */ }
				(_win.vscode as any).postMessage({ type: upgradeType, addKind: k, state });
			} catch {
				// ignore
			}
			return;
		}
	} catch {
		// ignore
	}

	// Normal .kqlx flow.
	if (k === 'query') return (_win.addQueryBox as any)();
	if (k === 'chart') return (_win.addChartBox as any)();
	if (k === 'transformation') return (_win.addTransformationBox as any)();
	if (k === 'markdown') return (_win.addMarkdownBox as any)();
	if (k === 'python') return (_win.addPythonBox as any)();
	if (k === 'url') return (_win.addUrlBox as any)();
	// copilotQuery sections are deprecated; Copilot chat is now a per-editor toolbar toggle.
}

// Replace the early bootstrap stub (defined in queryEditor.js before all scripts load).
// In some browsers, relying on a global function declaration is not enough to override
// an existing window property, so assign explicitly.
try {
	_win.__kustoRequestAddSection = __kustoRequestAddSection;
} catch {
	// ignore
}

// During restore, Monaco editors are created asynchronously.
// Stash initial values here so init*Editor can apply them once the editor exists.
_win.__kustoPendingQueryTextByBoxId = (_win.__kustoPendingQueryTextByBoxId as any) || {};
_win.__kustoPendingMarkdownTextByBoxId = (_win.__kustoPendingMarkdownTextByBoxId as any) || {};
_win.__kustoPendingPythonCodeByBoxId = (_win.__kustoPendingPythonCodeByBoxId as any) || {};

// Optional persisted query results (per box), stored as JSON text.
// This stays in-memory and is included in getKqlxState.
_win.__kustoQueryResultJsonByBoxId = (_win.__kustoQueryResultJsonByBoxId as any) || {};

// Persisted query results are stored inline in the .kqlx document.
// Keep a cap to avoid ballooning the file, but try hard to keep *some* results
// (e.g. truncate rows) instead of dropping them entirely.
//
// Note: this is per-query-box, and the document can contain multiple boxes.
// We intentionally allow several MB because session.kqlx lives in extension global storage.
const __kustoMaxPersistedResultBytes = 5 * 1024 * 1024;
const __kustoMaxPersistedResultRowsHardCap = 5000;

function __kustoByteLengthUtf8(text: any) {
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

function __kustoTryStoreQueryResult(boxId: any, result: any) {
	try {
		if (!boxId) return;
		let json = '';
		try {
			json = JSON.stringify(result ?? null);
		} catch {
			// If result isn't serializable, don't persist it.
			delete (_win.__kustoQueryResultJsonByBoxId as any)[boxId];
			return;
		}
		let bytes = __kustoByteLengthUtf8(json);
		if (bytes <= __kustoMaxPersistedResultBytes) {
			(_win.__kustoQueryResultJsonByBoxId as any)[boxId] = json;
			return;
		}

		// Too large: attempt to persist a truncated version (keep columns + metadata + top N rows).
		try {
			const cols = Array.isArray(result && result.columns) ? result.columns : [];
			const rows = Array.isArray(result && result.rows) ? result.rows : [];
			const meta = (result && result.metadata && typeof result.metadata === 'object') ? result.metadata : {};

			// If there are no rows to trim, give up.
			if (!rows || !Array.isArray(rows) || rows.length === 0) {
				delete (_win.__kustoQueryResultJsonByBoxId as any)[boxId];
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
				(_win.__kustoQueryResultJsonByBoxId as any)[boxId] = bestJson;
				return;
			}
		} catch {
			// ignore
		}

		// Still too large; do not persist.
		delete (_win.__kustoQueryResultJsonByBoxId as any)[boxId];
	} catch {
		// ignore
	}
}

// Called by main.js when query results arrive.
function __kustoOnQueryResult(boxId: any, result: any) {
	__kustoTryStoreQueryResult(boxId, result);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
			const map = (_win.__kustoManualQueryEditorHeightPxByBoxId as any);
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

function __kustoSetWrapperHeightPx(boxId: any, suffix: any, heightPx: any) {
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
			const editor = ((_win.queryEditors as any) && (_win.queryEditors as any)[boxId]) ? (_win.queryEditors as any)[boxId] : null;
			if (editor && typeof editor.layout === 'function') {
				editor.layout();
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
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
		} catch { /* ignore */ }
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
			const m = (_win.__kustoResultsVisibleByBoxId as any);
			resultsHidden = !!(m && m[boxId] === false);
		} catch { /* ignore */ }
		if (resultsHidden) {
			try { wrapper.dataset.kustoPreviousHeight = clamped + 'px'; } catch { /* ignore */ }
			try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			return;
		}
		wrapper.style.height = clamped + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		// If this section currently has short non-table content (errors, etc.), clamp on next tick.
		try {
			setTimeout(() => {
				try {
					if (typeof (_win.__kustoClampResultsWrapperHeight) === 'function') {
						(_win.__kustoClampResultsWrapperHeight as any)(boxId);
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
		if ((_win.__kustoCompatibilityMode as any)) {
			const singleKind = String((_win.__kustoCompatibilitySingleKind as any) || 'query');
			if (singleKind === 'markdown') {
				let firstMarkdownBoxId = null;
				try {
					const ids = Array.isArray((_win.__kustoMarkdownBoxes as any)) ? (_win.__kustoMarkdownBoxes as any) : [];
					for (const id of ids) {
						if (typeof id === 'string' && id.startsWith('markdown_')) {
							firstMarkdownBoxId = id;
							break;
						}
					}
				} catch { /* ignore */ }
				let text = '';
				try {
					text = (firstMarkdownBoxId && (_win.__kustoMarkdownEditors as any) && (_win.__kustoMarkdownEditors as any)[firstMarkdownBoxId])
						? ((_win.__kustoMarkdownEditors as any)[firstMarkdownBoxId].getValue() || '')
						: '';
				} catch { /* ignore */ }
				if (!text) {
					try {
						const pending = (_win.__kustoPendingMarkdownTextByBoxId as any) && firstMarkdownBoxId
							? (_win.__kustoPendingMarkdownTextByBoxId as any)[firstMarkdownBoxId]
							: undefined;
						if (typeof pending === 'string') {
							text = pending;
						}
					} catch { /* ignore */ }
				}
				return {
					caretDocsEnabled: (typeof (_win.caretDocsEnabled as any) === 'boolean') ? (_win.caretDocsEnabled as any) : true,
					autoTriggerAutocompleteEnabled: (typeof (_win.autoTriggerAutocompleteEnabled as any) === 'boolean') ? (_win.autoTriggerAutocompleteEnabled as any) : false,
					sections: [{ type: 'markdown', text }]
				};
			}

			let firstQueryBoxId = null;
			try {
				const ids = Array.isArray((_win.queryBoxes as any)) ? (_win.queryBoxes as any) : [];
				for (const id of ids) {
					if (typeof id === 'string' && id.startsWith('query_')) {
						firstQueryBoxId = id;
						break;
					}
				}
			} catch { /* ignore */ }
			const q = (firstQueryBoxId && (_win.queryEditors as any) && (_win.queryEditors as any)[firstQueryBoxId])
				? ((_win.queryEditors as any)[firstQueryBoxId].getValue() || '')
				: '';
			let clusterUrl = '';
			let database = '';
			let resultJson = '';
			let favoritesMode;
			try {
				if (firstQueryBoxId) {
					// Selection (clusterUrl + database)
					try {
						const connectionId = (_win.__kustoGetConnectionId as any) ? (_win.__kustoGetConnectionId as any)(firstQueryBoxId) : '';
						if (connectionId && Array.isArray((_win.connections as any))) {
							const conn = ((_win.connections as any) || []).find((c: any) => c && String(c.id || '') === String(connectionId));
							clusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch { /* ignore */ }
					try {
						database = (_win.__kustoGetDatabase as any) ? (_win.__kustoGetDatabase as any)(firstQueryBoxId) : '';
					} catch { /* ignore */ }
					// Persisted results (in-memory)
					try {
						if ((_win.__kustoQueryResultJsonByBoxId as any) && (_win.__kustoQueryResultJsonByBoxId as any)[firstQueryBoxId]) {
							resultJson = String((_win.__kustoQueryResultJsonByBoxId as any)[firstQueryBoxId]);
						}
					} catch { /* ignore */ }
					// Favorites picker UI mode
					try {
						if (typeof (_win.favoritesModeByBoxId as any) === 'object' && (_win.favoritesModeByBoxId as any) && Object.prototype.hasOwnProperty.call((_win.favoritesModeByBoxId as any), firstQueryBoxId)) {
							favoritesMode = !!(_win.favoritesModeByBoxId as any)[firstQueryBoxId];
						}
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			return {
				caretDocsEnabled: (typeof (_win.caretDocsEnabled as any) === 'boolean') ? (_win.caretDocsEnabled as any) : true,
				autoTriggerAutocompleteEnabled: (typeof (_win.autoTriggerAutocompleteEnabled as any) === 'boolean') ? (_win.autoTriggerAutocompleteEnabled as any) : false,
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
			// Lit component: delegate to its serialize() method if available.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try { sections.push((el as any).serialize()); } catch { /* ignore */ }
				continue;
			}
			// Legacy fallback.
			const querySectionType = 'query';
			const name = (_win.__kustoGetSectionName as any) ? (_win.__kustoGetSectionName as any)(id) : '';
			const connectionId = (_win.__kustoGetConnectionId as any) ? (_win.__kustoGetConnectionId as any)(id) : '';
			let favoritesMode;
			try {
				if (typeof (_win.favoritesModeByBoxId as any) === 'object' && (_win.favoritesModeByBoxId as any) && Object.prototype.hasOwnProperty.call((_win.favoritesModeByBoxId as any), id)) {
					favoritesMode = !!(_win.favoritesModeByBoxId as any)[id];
				}
			} catch { /* ignore */ }
			let expanded = true;
			try {
				expanded = !((_win.__kustoQueryExpandedByBoxId as any) && (_win.__kustoQueryExpandedByBoxId as any)[id] === false);
			} catch { /* ignore */ }
			let resultsVisible = true;
			try {
				resultsVisible = !((_win.__kustoResultsVisibleByBoxId as any) && (_win.__kustoResultsVisibleByBoxId as any)[id] === false);
			} catch { /* ignore */ }
			let clusterUrl = '';
			try {
				if (connectionId && Array.isArray((_win.connections as any))) {
					const conn = ((_win.connections as any) || []).find((c: any) => c && String(c.id || '') === String(connectionId));
					clusterUrl = conn ? String(conn.clusterUrl || '') : '';
				}
			} catch {
				// ignore
			}
			const database = (_win.__kustoGetDatabase as any) ? (_win.__kustoGetDatabase as any)(id) : '';
			let query = (_win.queryEditors as any) && (_win.queryEditors as any)[id] ? ((_win.queryEditors as any)[id].getValue() || '') : '';
			// If the editor hasn't initialized yet (e.g. Monaco still loading on a slow machine),
			// don't lose content: use the pending restore buffer.
			if (!query) {
				try {
					const pending = (_win.__kustoPendingQueryTextByBoxId as any) && (_win.__kustoPendingQueryTextByBoxId as any)[id];
					if (typeof pending === 'string' && pending) {
						query = pending;
					}
				} catch { /* ignore */ }
			}
			const resultJson = ((_win.__kustoQueryResultJsonByBoxId as any) && (_win.__kustoQueryResultJsonByBoxId as any)[id])
				? String((_win.__kustoQueryResultJsonByBoxId as any)[id])
				: '';
			const runMode = ((_win.runModesByBoxId as any) && (_win.runModesByBoxId as any)[id]) ? String((_win.runModesByBoxId as any)[id]) : 'take100';
			const cacheEnabled = !!((document.getElementById(id + '_cache_enabled') || {}) as any).checked;
			const cacheValue = parseInt(((document.getElementById(id + '_cache_value') || {}) as any).value || '1', 10) || 1;
			const cacheUnit = ((document.getElementById(id + '_cache_unit') || {}) as any).value || 'days';
			let copilotChatVisible;
			let copilotChatWidthPx;
			try {
				if (typeof (_win.__kustoGetCopilotChatVisible) === 'function') {
					copilotChatVisible = !!(_win.__kustoGetCopilotChatVisible as any)(id);
				}
			} catch { /* ignore */ }
			try {
				if (typeof (_win.__kustoGetCopilotChatWidthPx) === 'function') {
					const w = (_win.__kustoGetCopilotChatWidthPx as any)(id);
					if (typeof w === 'number' && Number.isFinite(w)) {
						copilotChatWidthPx = w;
					}
				}
			} catch { /* ignore */ }
			// Leave no trace: don't persist results from sensitive clusters
			const shouldPersistResult = resultJson && !__kustoIsLeaveNoTraceCluster(clusterUrl);
			sections.push({
				id,
				type: querySectionType,
				name,
				...(typeof favoritesMode === 'boolean' ? { favoritesMode } : {}),
				clusterUrl,
				database,
				query,
				expanded,
				resultsVisible,
				...(shouldPersistResult ? { resultJson } : {}),
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
			// Lit component: delegate to its serialize() method.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try {
					sections.push((el as any).serialize());
				} catch { /* ignore */ }
			}
			continue;
		}

		if (id.startsWith('transformation_')) {
			// Lit component: delegate to its serialize() method.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try {
					sections.push((el as any).serialize());
				} catch { /* ignore */ }
			}
			continue;
		}

		if (id.startsWith('markdown_')) {
			// Lit component: delegate to its serialize() method.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try {
					sections.push((el as any).serialize());
				} catch { /* ignore */ }
			}
			continue;
		}

		if (id.startsWith('python_')) {
			// Lit component: delegate to its serialize() method.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try {
					sections.push((el as any).serialize());
					continue;
				} catch { /* fall through to legacy path */ }
			}
			// Legacy fallback (for old-style boxes still in DOM during transition).
			let code = (_win.__kustoPythonEditors as any) && (_win.__kustoPythonEditors as any)[id] ? ((_win.__kustoPythonEditors as any)[id].getValue() || '') : '';
			if (!code) {
				try {
					const pending = (_win.__kustoPendingPythonCodeByBoxId as any) && (_win.__kustoPendingPythonCodeByBoxId as any)[id];
					if (typeof pending === 'string' && pending) {
						code = pending;
					}
				} catch { /* ignore */ }
			}
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
			// Lit component: delegate to its serialize() method.
			const el = document.getElementById(id);
			if (el && typeof (el as any).serialize === 'function') {
				try {
					sections.push((el as any).serialize());
				} catch { /* ignore */ }
			}
			continue;
		}
	}

	// Re-inject passthrough dev notes sections (hidden, no DOM elements)
	try {
		if (Array.isArray((_win.__kustoDevNotesSections as any))) {
			for (const dn of (_win.__kustoDevNotesSections as any)) {
				if (dn && dn.type === 'devnotes') sections.push(dn);
			}
		}
	} catch { /* ignore */ }

	return {
		caretDocsEnabled: (typeof (_win.caretDocsEnabled as any) === 'boolean') ? (_win.caretDocsEnabled as any) : true,
		autoTriggerAutocompleteEnabled: (typeof (_win.autoTriggerAutocompleteEnabled as any) === 'boolean') ? (_win.autoTriggerAutocompleteEnabled as any) : false,
		sections
	};
}

let __kustoLastPersistSignature = '';
// In compatibility mode (no sidecar), only the query text is saved to disk.
// Track the last query text separately so cluster/database-only changes don't
// trigger unnecessary persistDocument messages that would dirty the file.
let __kustoLastCompatQueryText = '';

function schedulePersist(reason?: any, immediate?: any) {
	if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
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
				if ((_win.__kustoCompatibilityMode as any)) {
					try {
						let compatQueryText = '';
						const sections = (state && Array.isArray(state.sections)) ? state.sections : [];
						const singleKind = String((_win.__kustoCompatibilitySingleKind as any) || 'query');
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
					} catch { /* ignore */ }
				}

				if (sig) {
					__kustoLastPersistSignature = sig;
				}
				(_win.vscode as any).postMessage({ type: 'persistDocument', state, reason: r });
			} catch {
				// ignore
			}
		};
		if (immediate) {
			// Immediate persist - no debounce
			doPersist();
		} else {
			__kustoPersistTimer = setTimeout(doPersist, 400);
		}
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
			if (!(_win.__kustoIsSessionFile as any)) {
				return;
			}
			if (!__kustoPersistenceEnabled || __kustoRestoreInProgress) {
				return;
			}
			const state = getKqlxState();
			(_win.vscode as any).postMessage({ type: 'persistDocument', state, flush: true, reason: 'flush' });
		} catch {
			// ignore
		}
	});
} catch {
	// ignore
}

function __kustoClearAllSections() {
	try {
		for (const id of ((_win.queryBoxes as any) || []).slice()) {
			try { (_win.removeQueryBox as any)(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of ((_win.__kustoChartBoxes as any) || []).slice()) {
			try { (_win.removeChartBox as any)(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of ((_win.__kustoMarkdownBoxes as any) || []).slice()) {
			try { (_win.removeMarkdownBox as any)(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of ((_win.__kustoPythonBoxes as any) || []).slice()) {
			try { (_win.removePythonBox as any)(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		for (const id of ((_win.__kustoUrlBoxes as any) || []).slice()) {
			try { (_win.removeUrlBox as any)(id); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	// Clear passthrough dev notes sections
	try { _win.__kustoDevNotesSections = []; } catch { /* ignore */ }
}

function applyKqlxState(state: any) {
	__kustoRestoreInProgress = true;
	_win.__kustoRestoreInProgress = true;
	try {
		__kustoPersistenceEnabled = false;

		// Reset persisted results when loading a new document.
		try { _win.__kustoQueryResultJsonByBoxId = {}; } catch { /* ignore */ }

		__kustoClearAllSections();

		const s = state && typeof state === 'object' ? state : { sections: [] };

		// Respect a global user preference (persisted in extension globalState) once it exists.
		// Only fall back to document state if the user has never explicitly toggled the feature.
		const userSet = (() => {
			try {
				return !!(_win.__kustoCaretDocsEnabledUserSet as any);
			} catch {
				return false;
			}
		})();
		if (!userSet && typeof s.caretDocsEnabled === 'boolean') {
			(_win.caretDocsEnabled as any) = !!s.caretDocsEnabled;
			try { (_win.updateCaretDocsToggleButtons as any)(); } catch { /* ignore */ }
		}

		const autoUserSet = (() => {
			try {
				return !!(_win.__kustoAutoTriggerAutocompleteEnabledUserSet as any);
			} catch {
				return false;
			}
		})();
		if (!autoUserSet && typeof s.autoTriggerAutocompleteEnabled === 'boolean') {
			(_win.autoTriggerAutocompleteEnabled as any) = !!s.autoTriggerAutocompleteEnabled;
			try { (_win.updateAutoTriggerAutocompleteToggleButtons as any)(); } catch { /* ignore */ }
		}

		// Compatibility mode (single-section plain text files): force exactly one editor and ignore all other sections.
		if ((_win.__kustoCompatibilityMode as any)) {
			const singleKind = String((_win.__kustoCompatibilitySingleKind as any) || 'query');
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
					} catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
			if (singleKind === 'markdown') {
				// IMPORTANT: pass text via options so addMarkdownBox can stash it before
				// initializing the TOAST UI editor (which triggers an immediate schedulePersist).
				const isPlainMd = String((_win.__kustoDocumentKind as any) || '') === 'md';
				// Initialize the compat text tracker so the first schedulePersist
				// after restore recognizes the baseline and only sends persistDocument
				// when the user actually edits the text (not just unrelated metadata).
				try { __kustoLastCompatQueryText = singleText; } catch { /* ignore */ }
				(_win.addMarkdownBox as any)({ text: singleText, mdAutoExpand: isPlainMd });
				return;
			}
			const boxId = (_win.addQueryBox as any)();
			// Apply optional suggested cluster/db selection for compatibility-mode query docs.
			try {
				const desiredClusterUrl = String(suggestedClusterUrl || '').trim();
				const db = String(suggestedDatabase || '').trim();
				const kwEl = (_win.__kustoGetQuerySectionElement as any) ? (_win.__kustoGetQuerySectionElement as any)(boxId) : null;
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
					if (desiredClusterUrl && db && typeof (_win.__kustoSetAutoEnterFavoritesForBox) === 'function') {
						(_win.__kustoSetAutoEnterFavoritesForBox as any)(boxId, desiredClusterUrl, db);
					}
				} catch { /* ignore */ }
				// Ensure dropdowns see the desired selection once (_win.connections as any)/favorites are available.
				try { (_win.updateConnectionSelects as any)(); } catch { /* ignore */ }
				try {
					if (typeof (_win.__kustoTryAutoEnterFavoritesModeForAllBoxes) === 'function') {
						(_win.__kustoTryAutoEnterFavoritesModeForAllBoxes as any)();
					}
				} catch { /* ignore */ }
			} catch {
				// ignore
			}
			try {
				(_win.__kustoPendingQueryTextByBoxId as any)[boxId] = singleText;
			} catch {
				// ignore
			}
			// Initialize the compat query text tracker so the first schedulePersist
			// after restore recognizes the baseline and only sends persistDocument
			// when the user actually edits the query text (not just cluster/database).
			try { __kustoLastCompatQueryText = singleText; } catch { /* ignore */ }
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
				for (const c of ((_win.connections as any) || [])) {
					if (!c) continue;
					const ck = normalizeClusterUrlKey(c.clusterUrl || '');
					if (ck && ck === key) {
						return String(c.id || '');
					}
				}
				// Fallback: match by short-name key.
				const sk = clusterShortNameKey(clusterUrl);
				if (sk) {
					for (const c of ((_win.connections as any) || [])) {
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
			if (t === 'devnotes') {
				// Dev notes are hidden — store as passthrough, no DOM element
				try {
					_win.__kustoDevNotesSections = (_win.__kustoDevNotesSections as any) || [];
					(_win.__kustoDevNotesSections as any).push(section);
				} catch { /* ignore */ }
				continue;
			}
			if (t === 'query' || t === 'copilotQuery') {
				const isLegacyCopilotQuerySection = t === 'copilotQuery';
				const boxId = (_win.addQueryBox as any)({
					id: (section.id ? String(section.id) : undefined),
					expanded: (typeof section.expanded === 'boolean') ? !!section.expanded : true,
					clusterUrl: String(section.clusterUrl || ''),
					database: String(section.database || '')
				});
				try {
					if ((_win.__kustoSetSectionName as any)) (_win.__kustoSetSectionName as any)(boxId, String(section.name || ''));
				} catch { /* ignore */ }
				try {
					const desiredClusterUrl = String(section.clusterUrl || '');
					const resolvedConnectionId = desiredClusterUrl ? findConnectionIdByClusterUrl(desiredClusterUrl) : '';
					const db = String(section.database || '');
					const kwEl = (_win.__kustoGetQuerySectionElement as any) ? (_win.__kustoGetQuerySectionElement as any)(boxId) : null;
					// If this saved selection exists in favorites, switch to Favorites mode by default.
					try {
						if (desiredClusterUrl && db && typeof (_win.__kustoSetAutoEnterFavoritesForBox) === 'function') {
							(_win.__kustoSetAutoEnterFavoritesForBox as any)(boxId, desiredClusterUrl, db);
						}
					} catch { /* ignore */ }
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
							} catch { /* ignore */ }
						} else {
							// Try again after (_win.connections as any) are populated.
							try { (_win.updateConnectionSelects as any)(); } catch { /* ignore */ }
						}
					}
					try {
						if (typeof (_win.__kustoTryAutoEnterFavoritesModeForAllBoxes) === 'function') {
							(_win.__kustoTryAutoEnterFavoritesModeForAllBoxes as any)();
						}
					} catch { /* ignore */ }
				} catch { /* ignore */ }
				// Restore explicit favorites-mode UI state (if present). This is important for
				// upgrade/reload flows where boxes are recreated and would otherwise default back
				// to cluster/database pickers.
				try {
					if (typeof section.favoritesMode === 'boolean') {
						if (typeof (_win.__kustoSetFavoritesModeForBox) === 'function') {
							(_win.__kustoSetFavoritesModeForBox as any)(boxId, !!section.favoritesMode);
						}
					}
				} catch { /* ignore */ }
				// Monaco editor may not exist yet; store pending text for initQueryEditor.
				try {
					(_win.__kustoPendingQueryTextByBoxId as any)[boxId] = String(section.query || '');
				} catch { /* ignore */ }
				// Restore per-query results visibility BEFORE displaying results,
				// so displayResult sees the hidden state when creating kw-data-table.
				try {
					if (typeof section.resultsVisible === 'boolean') {
						if (!((_win.__kustoResultsVisibleByBoxId as any)) || typeof (_win.__kustoResultsVisibleByBoxId) !== 'object') {
							_win.__kustoResultsVisibleByBoxId = {};
						}
						(_win.__kustoResultsVisibleByBoxId as any)[boxId] = !!section.resultsVisible;
					}
				} catch { /* ignore */ }
				// Restore last result (if present + parseable).
				try {
					const rj = section.resultJson ? String(section.resultJson) : '';
					if (rj) {
						// Keep in-memory cache aligned with restored boxes.
						(_win.__kustoQueryResultJsonByBoxId as any)[boxId] = rj;
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
								_win.lastExecutedBox = boxId;
								if (typeof (_win.displayResult) === 'function') {
									(_win.displayResult as any)(p);
								}
							}
						} catch {
							// If stored JSON is invalid, drop it.
							delete (_win.__kustoQueryResultJsonByBoxId as any)[boxId];
						}
					}
				} catch { /* ignore */ }
				try {
					(_win.setRunMode as any)(boxId, String(section.runMode || 'take100'));
				} catch { /* ignore */ }
				try {
					const ce = document.getElementById(boxId + '_cache_enabled');
					const cv = document.getElementById(boxId + '_cache_value');
					const cu = document.getElementById(boxId + '_cache_unit');
					if (ce) (ce as any).checked = (section.cacheEnabled !== false);
					if (cv) (cv as any).value = String(section.cacheValue || 1);
					if (cu) (cu as any).value = String(section.cacheUnit || 'days');
					try { (_win.toggleCacheControls as any)(boxId); } catch { /* ignore */ }
				} catch { /* ignore */ }
				// Apply results visibility UI (toggle button + legacy results wrapper).
				try {
					if (typeof section.resultsVisible === 'boolean') {
						try { (_win.__kustoUpdateQueryResultsToggleButton as any) && (_win.__kustoUpdateQueryResultsToggleButton as any)(boxId); } catch { /* ignore */ }
						try { (_win.__kustoApplyResultsVisibility as any) && (_win.__kustoApplyResultsVisibility as any)(boxId); } catch { /* ignore */ }
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
					if (typeof desiredVisible === 'boolean' && typeof (_win.__kustoSetCopilotChatVisible) === 'function') {
						(_win.__kustoSetCopilotChatVisible as any)(boxId, desiredVisible);
					}
				} catch { /* ignore */ }
				try {
					if (typeof (_win.__kustoSetCopilotChatWidthPx) === 'function' && typeof section.copilotChatWidthPx === 'number') {
						(_win.__kustoSetCopilotChatWidthPx as any)(boxId, section.copilotChatWidthPx);
					}
				} catch { /* ignore */ }
				// Monaco editor may initialize after restore; remember desired wrapper height for initQueryEditor.
				try {
					if (typeof section.editorHeightPx === 'number' && Number.isFinite(section.editorHeightPx) && section.editorHeightPx > 0) {
						if (!(_win.__kustoPendingWrapperHeightPxByBoxId as any)) _win.__kustoPendingWrapperHeightPxByBoxId = {};
						(_win.__kustoPendingWrapperHeightPxByBoxId as any)[boxId] = section.editorHeightPx;
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
							const editor = ((_win.queryEditors as any) && (_win.queryEditors as any)[boxId]) ? (_win.queryEditors as any)[boxId] : null;
							if (editor && typeof editor.layout === 'function') {
								editor.layout();
							}
						} catch { /* ignore */ }
					}, 0);
				} catch { /* ignore */ }
				continue;
			}

			if (t === 'chart') {
				const boxId = (_win.addChartBox as any)({
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
					if (typeof (_win.__kustoApplyChartMode as any) === 'function') {
						(_win.__kustoApplyChartMode as any)(boxId);
					}
					if (typeof (_win.__kustoApplyChartBoxVisibility as any) === 'function') {
						(_win.__kustoApplyChartBoxVisibility as any)(boxId);
					}
				} catch { /* ignore */ }
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
				} catch { /* ignore */ }
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
				} catch { /* ignore */ }
				const boxId = (_win.addTransformationBox as any)({
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
				const boxId = (_win.addMarkdownBox as any)({
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
				} catch { /* ignore */ }
				continue;
			}

			if (t === 'python') {
				// Store pending code so the Lit component can pick it up during Monaco init.
				const pendingId = section.id ? String(section.id) : ('python_' + Date.now());
				try {
					(_win.__kustoPendingPythonCodeByBoxId as any)[pendingId] = String(section.code || '');
				} catch { /* ignore */ }
				const boxId = (_win.addPythonBox as any)({ id: pendingId });
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
				} catch { /* ignore */ }
				continue;
			}

			if (t === 'url') {
				const boxId = (_win.addUrlBox as any)({
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
				} catch { /* ignore */ }
				continue;
			}
		}
	} finally {
		__kustoRestoreInProgress = false;
		_win.__kustoRestoreInProgress = false;
		__kustoPersistenceEnabled = true;
		// Do not auto-persist immediately after restore: Monaco editors may not be ready yet,
		// and persisting too early can overwrite loaded content with empty strings.
	}
}

function __kustoApplyPendingAdds() {
	const pendingAdds = ((_win.__kustoQueryEditorPendingAdds as any) && typeof (_win.__kustoQueryEditorPendingAdds) === 'object')
		? (_win.__kustoQueryEditorPendingAdds as any)
		: { query: 0, markdown: 0, python: 0, url: 0 };
	// Reset counts so they don't replay on reload.
	_win.__kustoQueryEditorPendingAdds = { query: 0, markdown: 0, python: 0, url: 0 };

	const pendingTotal = (pendingAdds.query || 0) + (pendingAdds.markdown || 0) + (pendingAdds.python || 0) + (pendingAdds.url || 0);
	if (pendingTotal <= 0) {
		return false;
	}
	const allowed = Array.isArray((_win.__kustoAllowedSectionKinds as any))
		? (_win.__kustoAllowedSectionKinds as any).map((v: any) => String(v))
		: ['query', 'markdown', 'python', 'url'];
	if (allowed.includes('query')) {
		for (let i = 0; i < (pendingAdds.query || 0); i++) (_win.addQueryBox as any)();
	}
	if (allowed.includes('markdown')) {
		for (let i = 0; i < (pendingAdds.markdown || 0); i++) (_win.addMarkdownBox as any)();
	}
	if (allowed.includes('python')) {
		for (let i = 0; i < (pendingAdds.python || 0); i++) (_win.addPythonBox as any)();
	}
	if (allowed.includes('url')) {
		for (let i = 0; i < (pendingAdds.url || 0); i++) (_win.addUrlBox as any)();
	}
	return true;
}

function handleDocumentDataMessage(message: any) {
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
	} catch {
		// ignore
	}
	__kustoHasAppliedDocument = true;
	try {
		if (message && typeof message.documentUri === 'string') {
			__kustoLastAppliedDocumentUri = String(message.documentUri);
		}
	} catch {
		// ignore
	}

	// Some host-to-webview messages can arrive before the webview registers its message listener.
	// documentData is requested by the webview after initialization, so it is a reliable place
	// to apply compatibility mode for .kql/.csl files.
	try {
		if (typeof message.compatibilityMode === 'boolean') {
			if (typeof __kustoSetCompatibilityMode === 'function') {
				__kustoSetCompatibilityMode(!!message.compatibilityMode);
			} else {
				_win.__kustoCompatibilityMode = !!message.compatibilityMode;
			}
		}
	} catch {
		// ignore
	}

	// Capabilities can arrive either via persistenceMode or (for robustness) piggybacked on documentData.
	// This prevents restore issues when messages arrive out-of-order.
	try {
		if (typeof message.documentUri === 'string') {
			_win.__kustoDocumentUri = String(message.documentUri);
		}
		if (Array.isArray(message.allowedSectionKinds)) {
			_win.__kustoAllowedSectionKinds = message.allowedSectionKinds.map((k: any) => String(k));
		}
		if (typeof message.documentKind === 'string') {
			_win.__kustoDocumentKind = String(message.documentKind);
			try {
				if (document && document.body && document.body.dataset) {
					document.body.dataset.kustoDocumentKind = String(message.documentKind);
				}
			} catch { /* ignore */ }
		}
		if (typeof message.defaultSectionKind === 'string') {
			_win.__kustoDefaultSectionKind = String(message.defaultSectionKind);
		}
		if (typeof message.compatibilitySingleKind === 'string') {
			_win.__kustoCompatibilitySingleKind = String(message.compatibilitySingleKind);
		}
		if (typeof message.upgradeRequestType === 'string') {
			_win.__kustoUpgradeRequestType = String(message.upgradeRequestType);
		}
		if (typeof message.compatibilityTooltip === 'string') {
			_win.__kustoCompatibilityTooltip = String(message.compatibilityTooltip);
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
		const hasAny = ((_win.queryBoxes as any) && (_win.queryBoxes as any).length) || ((_win.__kustoMarkdownBoxes as any) && (_win.__kustoMarkdownBoxes as any).length) || ((_win.__kustoPythonBoxes as any) && (_win.__kustoPythonBoxes as any).length) || ((_win.__kustoUrlBoxes as any) && (_win.__kustoUrlBoxes as any).length);
		if (!hasAny) {
			const applied = __kustoApplyPendingAdds();
			if (!applied) {
				const k = String((_win.__kustoDefaultSectionKind as any) || 'query');
				if (k === 'markdown') {
					(_win.addMarkdownBox as any)();
				} else {
					(_win.addQueryBox as any)();
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
				if (typeof (_win.queryBoxes as any) !== 'undefined' && Array.isArray((_win.queryBoxes as any))) {
					for (const boxId of (_win.queryBoxes as any)) {
						// Check if this box is expanded (visible)
						let expanded = true;
						try {
							expanded = !((_win.__kustoQueryExpandedByBoxId as any) && (_win.__kustoQueryExpandedByBoxId as any)[boxId] === false);
						} catch { /* ignore */ }
						if (expanded && typeof (_win.__kustoUpdateSchemaForFocusedBox) === 'function') {
							// Only request schema for the first expanded box, then break
							(_win.__kustoUpdateSchemaForFocusedBox as any)(boxId);
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

// ======================================================================
// Window bridge: expose globals for remaining legacy callers
// ======================================================================
_win.schedulePersist = schedulePersist;
_win.getKqlxState = getKqlxState;
_win.handleDocumentDataMessage = handleDocumentDataMessage;
_win.__kustoOnQueryResult = __kustoOnQueryResult;
_win.__kustoTryStoreQueryResult = __kustoTryStoreQueryResult;
_win.__kustoRequestAddSection = __kustoRequestAddSection;
_win.__kustoSetCompatibilityMode = __kustoSetCompatibilityMode;
_win.__kustoApplyDocumentCapabilities = __kustoApplyDocumentCapabilities;
_win.__kustoNormalizeClusterUrl = __kustoNormalizeClusterUrl;
_win.__kustoIsLeaveNoTraceCluster = __kustoIsLeaveNoTraceCluster;
_win.__kustoSetWrapperHeightPx = __kustoSetWrapperHeightPx;
_win.__kustoGetWrapperHeightPx = __kustoGetWrapperHeightPx;
_win.__kustoGetQueryResultsOutputHeightPx = __kustoGetQueryResultsOutputHeightPx;
_win.__kustoSetQueryResultsOutputHeightPx = __kustoSetQueryResultsOutputHeightPx;

