// Toolbar rendering, action buttons, run modes, share modal, overflow menu.
// Extracted from queryBoxes.ts (Phase 6 decomposition).
// Window bridge exports at bottom for remaining legacy callers.
import { getRunModeLabelText } from '../shared/comparisonUtils';
import { postMessageToHost } from '../shared/webview-messages';
import { getResultsState } from '../core/results-state';
import {
	__kustoGetConnectionId, __kustoGetDatabase, __kustoGetSectionName,
	closeAllFavoritesDropdowns,
	fullyQualifyTablesInEditor
} from './queryBoxes';
import { executeQuery, __kustoIsRunSelectionReady } from './queryBoxes-execution';
import { toolbarScrollAtOpen, closeAllMenus } from './dropdown';
import { schedulePersist } from '../core/persistence';
import {
	queryBoxes, queryEditors, connections,
	caretDocsEnabled, setCaretDocsEnabled,
	autoTriggerAutocompleteEnabled, setAutoTriggerAutocompleteEnabled,
	copilotInlineCompletionsEnabled, setCopilotInlineCompletionsEnabled,
	activeQueryEditorBoxId, setActiveQueryEditorBoxId,
	caretDocOverlaysByBoxId, optimizationMetadataByBoxId,
	qualifyTablesInFlightByBoxId, runModesByBoxId,
} from '../core/state';

// --- Toggle button functions ---

export function updateCaretDocsToggleButtons() {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCaretDocsActive === 'function') {
				toolbar.setCaretDocsActive(!!caretDocsEnabled);
				continue;
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function updateAutoTriggerAutocompleteToggleButtons() {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setAutoCompleteActive === 'function') {
				toolbar.setAutoCompleteActive(!!autoTriggerAutocompleteEnabled);
				continue;
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function toggleAutoTriggerAutocompleteEnabled() {
	setAutoTriggerAutocompleteEnabled(!autoTriggerAutocompleteEnabled);
	try { window.__kustoAutoTriggerAutocompleteEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateAutoTriggerAutocompleteToggleButtons();
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({ type: 'setAutoTriggerAutocompleteEnabled', enabled: !!autoTriggerAutocompleteEnabled });
	} catch (e) { console.error('[kusto]', e); }

	// When enabling, kick once for the currently focused editor (matches ADX feel).
	if (autoTriggerAutocompleteEnabled) {
		try {
			const boxId = (typeof activeQueryEditorBoxId === 'string') ? activeQueryEditorBoxId : null;
			if (boxId && typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function updateCopilotInlineCompletionsToggleButtons() {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCopilotInlineActive === 'function') {
				toolbar.setCopilotInlineActive(!!copilotInlineCompletionsEnabled);
				continue;
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function toggleCopilotInlineCompletionsEnabled() {
	setCopilotInlineCompletionsEnabled(!copilotInlineCompletionsEnabled);
	try { window.__kustoCopilotInlineCompletionsEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateCopilotInlineCompletionsToggleButtons();
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({ type: 'setCopilotInlineCompletionsEnabled', enabled: !!copilotInlineCompletionsEnabled });
	} catch (e) { console.error('[kusto]', e); }
}

export function toggleCaretDocsEnabled() {
	setCaretDocsEnabled(!caretDocsEnabled);
	updateCaretDocsToggleButtons();
	// Hide existing overlays immediately when turning off.
	if (!caretDocsEnabled) {
		try {
			for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
				const overlay = caretDocOverlaysByBoxId[key];
				if (overlay && typeof overlay.hide === 'function') {
					overlay.hide();
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	} else {
		// When turning on, show the banner immediately (watermark) without waiting for cursor movement.
		try {
			const watermarkTitle = 'Smart documentation';
			const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';
			for (const boxId of queryBoxes) {
				try {
					const banner = document.getElementById(boxId + '_caret_docs') as any;
					const text = document.getElementById(boxId + '_caret_docs_text') || banner;
					if (banner) {
						banner.style.display = 'flex';
					}
					if (text) {
						text.innerHTML =
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' +
							watermarkTitle +
							'</div>' +
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' +
							watermarkBody +
							'</div>';
						if (text.classList) {
							text.classList.add('is-watermark');
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Then refresh any Monaco-driven overlays so real docs content replaces the watermark.
		try {
			const overlays = (typeof caretDocOverlaysByBoxId !== 'undefined') ? caretDocOverlaysByBoxId : null;
			if (overlays && typeof overlays === 'object') {
				for (const key of Object.keys(overlays)) {
					try {
						const o = overlays[key];
						if (o && typeof o.update === 'function') {
							o.update();
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	try {
		postMessageToHost({ type: 'setCaretDocsEnabled', enabled: !!caretDocsEnabled });
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// --- Toolbar action dispatcher ---

export function onQueryEditorToolbarAction( boxId: any, action: any) {
	// Focus the editor so Monaco widgets (find/replace) attach correctly.
	try {
		setActiveQueryEditorBoxId(boxId);
		if (queryEditors[boxId]) {
			queryEditors[boxId].focus();
		}
	} catch (e) { console.error('[kusto]', e); }

	if (action === 'undo') {
		try {
			const editor = queryEditors[boxId];
			if (editor) {
				editor.trigger('toolbar', 'undo', null);
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'redo') {
		try {
			const editor = queryEditors[boxId];
			if (editor) {
				editor.trigger('toolbar', 'redo', null);
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'search') {
		return runMonacoAction(boxId, 'actions.find');
	}
	if (action === 'replace') {
		return runMonacoAction(boxId, 'editor.action.startFindReplaceAction');
	}
	if (action === 'prettify') {
		try {
			if (typeof window.__kustoPrettifyQueryForBoxId === 'function') {
				window.__kustoPrettifyQueryForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		// Fallback: at least run the basic formatter.
		return runMonacoAction(boxId, 'editor.action.formatDocument');
	}
	if (action === 'singleLine') {
		try {
			if (typeof window.__kustoCopySingleLineQueryForBoxId === 'function') {
				window.__kustoCopySingleLineQueryForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'autocomplete') {
		try {
			if (typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		return runMonacoAction(boxId, 'editor.action.triggerSuggest');
	}
	if (action === 'doubleToSingle') {
		return replaceAllInEditor(boxId, '"', "'");
	}
	if (action === 'singleToDouble') {
		return replaceAllInEditor(boxId, "'", '"');
	}
	if (action === 'exportPowerBI') {
		return exportQueryToPowerBI(boxId);
	}
	if (action === 'copyAdeLink') {
		return copyQueryAsAdeLink(boxId);
	}
	if (action === 'qualifyTables') {
		try {
			if (qualifyTablesInFlightByBoxId && qualifyTablesInFlightByBoxId[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try { qualifyTablesInFlightByBoxId[boxId] = true; } catch (e) { console.error('[kusto]', e); }
		try { setToolbarActionBusy(boxId, 'qualifyTables', true); } catch (e) { console.error('[kusto]', e); }
		(async () => {
			try {
				await fullyQualifyTablesInEditor(boxId);
			} finally {
				try { qualifyTablesInFlightByBoxId[boxId] = false; } catch (e) { console.error('[kusto]', e); }
				try { setToolbarActionBusy(boxId, 'qualifyTables', false); } catch (e) { console.error('[kusto]', e); }
			}
		})();
		return;
	}
}

// --- Share / ADE link ---

function copyQueryAsAdeLink( boxId: any) {
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
	// If the editor has multiple statements (blank-line separated), use only the statement at cursor.
	try {
		if (editor) {
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
					try {
						postMessageToHost({
							type: 'showInfo',
							message: 'Place the cursor inside a query statement (not on a separator) to copy a Data Explorer link for that statement.'
						});
					} catch (e) { console.error('[kusto]', e); }
					return;
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	let connectionId = __kustoGetConnectionId(boxId);
	let database = __kustoGetDatabase(boxId);

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(sourceBoxId);
				const srcDb = __kustoGetDatabase(sourceBoxId);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	if (!String(query || '').trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'There is no query text to share.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!String(connectionId || '').trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'Select a cluster connection first.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!String(database || '').trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'Select a database first.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	try {
		postMessageToHost({
			type: 'copyAdeLink',
			query,
			connectionId,
			database,
			boxId
		});
	} catch (e) { console.error('[kusto]', e); }
}

/**
 * Opens the Share modal for a query section, allowing users to copy
 * title, query, and results to clipboard formatted for Teams.
 */
export function __kustoOpenShareModal( boxId: any) {
	if (!boxId) return;

	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;

	// Store the active box id on the modal.
	modal.dataset.boxId = boxId;

	// Pre-populate the section name.
	const nameInput = null;
	const sectionName = __kustoGetSectionName(boxId);
	const titleEl = document.getElementById('shareModal_title') as any;
	if (titleEl) titleEl.textContent = sectionName || 'Kusto Query';

	// Determine whether results are available.
	const state = getResultsState(boxId);
	const hasResults = !!(state && Array.isArray(state.columns) && state.columns.length > 0 && Array.isArray(state.rows) && state.rows.length > 0);
	const totalRows = hasResults ? state.rows.length : 0;
	const resultsCheck = document.getElementById('shareModal_chk_results') as any;
	if (resultsCheck) {
		resultsCheck.checked = hasResults;
		resultsCheck.disabled = !hasResults;
	}
	const resultsLabel = document.getElementById('shareModal_label_results') as any;
	if (resultsLabel) {
		resultsLabel.classList.toggle('share-modal-option-disabled', !hasResults);
	}

	// Set up row limit input with total row count.
	const rowLimitInput = document.getElementById('shareModal_rowLimit') as any;
	if (rowLimitInput) {
		rowLimitInput.max = String(totalRows || 200);
		rowLimitInput.value = String(Math.min(totalRows || 10, 10));
		rowLimitInput.disabled = !hasResults;
	}
	const rowLimitGroup = document.getElementById('shareModal_rowLimitGroup') as any;
	if (rowLimitGroup) {
		rowLimitGroup.style.display = hasResults ? '' : 'none';
	}
	const resultsSubtitle = document.getElementById('shareModal_results_subtitle') as any;
	if (resultsSubtitle) {
		resultsSubtitle.textContent = 'Formatted as a table';
	}
	const rowLimitTotal = document.getElementById('shareModal_rowLimitTotal') as any;
	if (rowLimitTotal) {
		rowLimitTotal.textContent = 'of ' + totalRows.toLocaleString() + ' rows';
	}

	// Determine whether we have connection info for the ADE link.
	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch (e) { console.error('[kusto]', e); }

	// Inherit from source box if this is a comparison section.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const src = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(src);
				const srcDb = __kustoGetDatabase(src);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	const hasLink = !!(String(connectionId || '').trim() && String(database || '').trim());
	const linkCheck = document.getElementById('shareModal_chk_title') as any;
	if (linkCheck) {
		linkCheck.checked = hasLink;
		linkCheck.disabled = !hasLink;
	}
	const linkLabel = document.getElementById('shareModal_label_title') as any;
	if (linkLabel) {
		linkLabel.classList.toggle('share-modal-option-disabled', !hasLink);
	}

	// Also update the link subtitle with a preview of what we'll generate.
	const linkSubtitle = document.getElementById('shareModal_link_subtitle') as any;
	if (linkSubtitle) {
		linkSubtitle.textContent = hasLink ? 'Includes a Direct link to query (Azure Data Explorer)' : 'Select a cluster and database to include a link';
	}

	// Reset the query checkbox.
	const queryCheck = document.getElementById('shareModal_chk_query') as any;
	if (queryCheck) {
		const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
		const hasQuery = !!(editor && String(editor.getValue() || '').trim());
		queryCheck.checked = hasQuery;
		queryCheck.disabled = !hasQuery;
	}

	// Show the modal.
	modal.classList.add('visible');
}

export function __kustoCloseShareModal( event?: any) {
	if (event && event.target && event.target.id !== 'shareModal') return;
	const modal = document.getElementById('shareModal') as any;
	if (modal) modal.classList.remove('visible');
}

export function __kustoShareCopyToClipboard() {
	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;
	const boxId = modal.dataset.boxId;
	if (!boxId) return;

	const includeTitle = !!(document.getElementById('shareModal_chk_title') as any || {}).checked;
	const includeQuery = !!(document.getElementById('shareModal_chk_query') as any || {}).checked;
	const includeResults = !!(document.getElementById('shareModal_chk_results') as any || {}).checked;

	if (!includeTitle && !includeQuery && !includeResults) {
		try { postMessageToHost({ type: 'showInfo', message: 'Select at least one section to share.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	// Gather query text.
	let queryText = '';
	try {
		const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
		queryText = editor ? (editor.getValue() || '') : '';
	} catch (e) { console.error('[kusto]', e); }

	// Gather connection info.
	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const src = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(src);
				const srcDb = __kustoGetDatabase(src);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Gather results data.
	let columns: any[] = [];
	let rowsData: any[] = [];
	let totalRows = 0;
	if (includeResults) {
		try {
			const state = getResultsState(boxId);
			if (state && Array.isArray(state.columns) && Array.isArray(state.rows)) {
				// columns are plain strings in state.columns.
				columns = state.columns.map((c: any) => (c && typeof c === 'object' && c.name) ? String(c.name) : String(c ?? ''));
				totalRows = state.rows.length;
				// Read the user-configured row limit from the Share modal input.
				let rowLimit = 10;
				try {
					const rlInput = document.getElementById('shareModal_rowLimit') as any;
					if (rlInput) {
						const parsed = parseInt(rlInput.value, 10);
						if (parsed > 0) rowLimit = parsed;
					}
				} catch (e) { console.error('[kusto]', e); }
				const maxRows = Math.min(totalRows, rowLimit);
				for (let i = 0; i < maxRows; i++) {
					const row = state.rows[i];
					if (!Array.isArray(row)) continue;
					const vals: any[] = [];
					for (let j = 0; j < row.length; j++) {
						const cell = row[j];
						// Use the same display pipeline as the results table so
						// numbers have commas, dates are formatted, etc.
						const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
						const displayValue = hasHover ? cell.display : cell;
						const formatted = String(displayValue ?? '');
						vals.push(String(formatted ?? ''));
					}
					rowsData.push(vals);
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	// Get section name.
	let sectionName = '';
	try {
		sectionName = __kustoGetSectionName(boxId);
	} catch (e) { console.error('[kusto]', e); }

	// Send to extension to build ADE link and copy to clipboard.
	try {
		postMessageToHost({
			type: 'shareToClipboard',
			boxId,
			includeTitle,
			includeQuery,
			includeResults,
			sectionName,
			queryText,
			connectionId,
			database,
			columns,
			rowsData,
			totalRows
		});
	} catch (e) { console.error('[kusto]', e); }

	// Close the modal.
	__kustoCloseShareModal();
}

// --- Toolbar busy state ---

function setToolbarActionBusy( boxId: any, action: any, busy: any) {
	try {
		const root = document.getElementById(boxId) as any;
		if (!root) return;
		const btn = root.querySelector('.query-editor-toolbar-btn[data-qe-action="' + action + '"]');
		if (btn) {
			if (busy) {
				if (!btn.dataset.qePrevHtml) {
					btn.dataset.qePrevHtml = btn.innerHTML;
				}
				btn.disabled = true;
				btn.setAttribute('aria-busy', 'true');
				btn.innerHTML = '<span class="schema-spinner" aria-hidden="true"></span>';
			} else {
				btn.disabled = false;
				btn.removeAttribute('aria-busy');
				if (btn.dataset.qePrevHtml) {
					btn.innerHTML = btn.dataset.qePrevHtml;
					delete btn.dataset.qePrevHtml;
				}
			}
		}

		// If the action button is not present (because it lives inside a dropdown menu),
		// reflect the busy state on the tools dropdown button via the Lit element.
		if (!btn && action === 'qualifyTables') {
			try {
				const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
				if (toolbar && typeof toolbar.setToolsBusy === 'function') {
					toolbar.setToolsBusy(!!busy);
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// --- Toolbar overflow handling ---
// Track ResizeObservers for run button responsiveness
const __kustoRunBtnResizeObservers: any = {};

/**
 * Initialize toolbar overflow detection for a query box.
 * Now a no-op — the <kw-query-toolbar> Lit element sets up its own ResizeObserver
 * in firstUpdated(). Kept as a window bridge for backward compatibility with
 * callers like monaco.ts.
 */
export function initToolbarOverflow( boxId: any) {
	// Toolbar overflow is now managed by <kw-query-toolbar> internally.
	// Also initialize run button responsiveness (still handled externally for now).
	initRunButtonResponsive(boxId);
}

/**
 * Initialize responsive behavior for the Run button.
 * When the query box is narrow, hide the label and show only the play icon.
 */
function initRunButtonResponsive( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;

	// Clean up any existing observer
	if (__kustoRunBtnResizeObservers[id]) {
		try { __kustoRunBtnResizeObservers[id].disconnect(); } catch (e) { console.error('[kusto]', e); }
	}

	// Create new observer on the query box itself
	const observer = new ResizeObserver(() => {
		try { updateRunButtonResponsive(id); } catch (e) { console.error('[kusto]', e); }
	});
	observer.observe(queryBox);
	__kustoRunBtnResizeObservers[id] = observer;

	// Initial check
	requestAnimationFrame(() => {
		try { updateRunButtonResponsive(id); } catch (e) { console.error('[kusto]', e); }
	});
}

/**
 * Update run button compact/expanded state based on available width.
 */
function updateRunButtonResponsive( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	if (!runBtn) return;

	// Get the query box width
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;
	const boxWidth = queryBox.offsetWidth;

	// Threshold: if box is narrower than 400px, use compact mode
	const compactThreshold = 400;
	if (boxWidth < compactThreshold) {
		runBtn.classList.add('is-compact');
	} else {
		runBtn.classList.remove('is-compact');
	}
}

// --- Monaco / editor helpers ---

function runMonacoAction( boxId: any, actionId: any) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	try {
		const action = editor.getAction(actionId);
		if (action && typeof action.run === 'function') {
			action.run();
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
}

function replaceAllInEditor( boxId: any, from: any, to: any) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const value = model.getValue();
	if (!value) {
		return;
	}
	const next = value.split(from).join(to);
	if (next === value) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch (e) { console.error('[kusto]', e); }
}

// --- Power BI export ---

async function exportQueryToPowerBI( boxId: any) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	let query = model.getValue() || '';
	// If the editor has multiple statements (blank-line separated), use only the statement at cursor.
	try {
		const blocks = (typeof window.__kustoGetStatementBlocksFromModel === 'function')
			? window.__kustoGetStatementBlocksFromModel(model)
			: [];
		const hasMultipleStatements = blocks && blocks.length > 1;
		if (hasMultipleStatements) {
			const statement = (typeof window.__kustoExtractStatementTextAtCursor === 'function')
				? window.__kustoExtractStatementTextAtCursor(editor)
				: null;
			if (statement) {
				query = statement;
			} else {
				try {
					postMessageToHost({
						type: 'showInfo',
						message: 'Place the cursor inside a query statement (not on a separator) to export that statement to Power BI.'
					});
				} catch (e) { console.error('[kusto]', e); }
				return;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
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

	const normalizedQuery = (query || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const escapeMString = (s: any) => String(s).replace(/"/g, '""');
	// Escape and indent each line of the query for readability inside the M string
	const indentedQuery = normalizedQuery.split('\n').map((l: any) => '        ' + escapeMString(l)).join('\n');
	const m =
		'let\n' +
		'    Query = Text.Combine({"\n' +
		indentedQuery + '\n' +
		'    "}, ""),\n' +
		'    Source = AzureDataExplorer.Contents("' + escapeMString(clusterUrl) + '", "' + escapeMString(database) + '", Query)\n' +
		'in\n' +
		'    Source';

	// Write to clipboard instead of changing the editor contents.
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(m);
			try {
				postMessageToHost({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
			} catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Fallback path (older webview/permission edge cases).
	try {
		const ta = document.createElement('textarea');
		ta.value = m;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.top = '0';
		(document.body || document.documentElement).appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		try { ta.parentNode && ta.parentNode.removeChild(ta); } catch (e) { console.error('[kusto]', e); }
		if (!ok) {
			throw new Error('copy failed');
		}
		try {
			postMessageToHost({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
		} catch (e) { console.error('[kusto]', e); }
	} catch {
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to copy Power BI query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
	}
}

// --- Run mode ---

function __kustoApplyRunModeFromMenu( boxId: any, mode: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	setRunMode(id, mode);
	// Only execute if selection is valid; otherwise we just changed the default run mode.
	try {
		if (__kustoIsRunSelectionReady(id)) {
			executeQuery(id, mode);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { closeRunMenu(id); } catch (e) { console.error('[kusto]', e); }
}

export function getRunMode( boxId: any) {
	return runModesByBoxId[boxId] || 'take100';
}

// getRunModeLabelText imported from ../shared/comparisonUtils.ts

export function setRunMode( boxId: any, mode: any) {
	runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	if (runBtn) {
		const labelSpan = runBtn.querySelector('.run-btn-label');
		const labelText = getRunModeLabelText(runModesByBoxId[boxId]);
		if (labelSpan) {
			labelSpan.textContent = ' ' + labelText;
		}
		// Update tooltip
		const isEnabled = !runBtn.disabled;
		runBtn.title = labelText + (isEnabled ? '' : '\nSelect a cluster and database first (or select a favorite)');
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function closeRunMenu( boxId: any) {
	const menu = document.getElementById(boxId + '_run_menu') as any;
	if (menu) {
		menu.style.display = 'none';
	}
}

export function closeAllRunMenus() {
	if (!queryBoxes) return;
	queryBoxes.forEach((id: any) => closeRunMenu(id));
}

function toggleRunMenu( boxId: any) {
	const menu = document.getElementById(boxId + '_run_menu') as any;
	if (!menu) {
		return;
	}
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	menu.style.display = next;
}

// --- Global dropdown dismiss handlers ---

const __kustoEventIsInsideDropdownUi = (ev: any) => {
	try {
		const t = ev && ev.target ? ev.target : null;
		if (!t || !t.closest) return false;
		// Note: dropdowns/menus are used for cluster/database/favorites and some tool UI.
		return !!(
			t.closest('.kusto-dropdown-menu') ||
			t.closest('.kusto-favorites-menu') ||
			t.closest('.kusto-dropdown-btn') ||
			t.closest('.kusto-favorites-btn') ||
			t.closest('.kusto-dropdown-wrapper') ||
			t.closest('.qe-toolbar-dropdown-menu') ||
			t.closest('.qe-toolbar-overflow-menu')
		);
	} catch {
		return false;
	}
};

document.addEventListener('click', (ev: any) => {
	// Clicking inside a dropdown should not dismiss it.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
	try { closeAllMenus(); } catch (e) { console.error('[kusto]', e); }
});

// Close dropdowns on scroll/wheel so they don't float detached from their buttons.
// Legacy run-mode menus close immediately (ephemeral). Interactive dropdowns
// handled by Lit components use their own threshold-based dismiss.
document.addEventListener('scroll', (ev: any) => {
	// The dropdown menus themselves are scrollable; do not dismiss on internal menu scroll.
	try {
		const target = ev && ev.target ? ev.target : null;
		if (target && target.closest && (target.closest('.kusto-dropdown-menu') || target.closest('.kusto-favorites-menu'))) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
	// Run menus are ephemeral — close immediately
	closeAllRunMenus();
	// Legacy dropdown module (used by tools, cache settings, etc.) — close with threshold
	try {
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - toolbarScrollAtOpen) > 20) {
			closeAllMenus();
		}
	} catch (e) { console.error('[kusto]', e); }
}, true); // Use capture to catch scroll events on nested scrollable elements

document.addEventListener('wheel', (ev: any) => {
	// Allow scrolling inside dropdown menus without dismissing them.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	// Run menus are ephemeral — close immediately on wheel
	closeAllRunMenus();
	// Legacy dropdown menus also close on wheel (users expect wheel to dismiss)
	try { closeAllMenus(); } catch (e) { console.error('[kusto]', e); }
}, { passive: true });

// ── Window bridges for remaining legacy callers ──
window.updateCaretDocsToggleButtons = updateCaretDocsToggleButtons;
window.updateAutoTriggerAutocompleteToggleButtons = updateAutoTriggerAutocompleteToggleButtons;
window.toggleAutoTriggerAutocompleteEnabled = toggleAutoTriggerAutocompleteEnabled;
window.toggleCopilotInlineCompletionsEnabled = toggleCopilotInlineCompletionsEnabled;
window.toggleCaretDocsEnabled = toggleCaretDocsEnabled;
window.onQueryEditorToolbarAction = onQueryEditorToolbarAction;
window.__kustoCloseShareModal = __kustoCloseShareModal;
window.__kustoShareCopyToClipboard = __kustoShareCopyToClipboard;
window.initToolbarOverflow = initToolbarOverflow;
window.__kustoApplyRunModeFromMenu = __kustoApplyRunModeFromMenu;
window.setRunMode = setRunMode;
window.closeAllRunMenus = closeAllRunMenus;
window.toggleRunMenu = toggleRunMenu;
