// Toolbar rendering, action buttons, run modes, share modal, overflow menu.
// Extracted from queryBoxes.ts (Phase 6 decomposition).
// Window bridge exports at bottom for remaining legacy callers.
import { getRunModeLabelText } from '../shared/comparisonUtils';
import { getResultsState } from './resultsState';
import {
	__kustoGetConnectionId, __kustoGetDatabase, __kustoGetSectionName,
	closeAllFavoritesDropdowns,
	fullyQualifyTablesInEditor
} from './queryBoxes';
import { executeQuery, __kustoIsRunSelectionReady } from './queryBoxes-execution';
import { closeMenuDropdown, toggleMenuDropdown, wireMenuInteractions, renderMenuItemsHtml } from './dropdown';

const _win = window;

// --- Toggle button functions ---

export function updateCaretDocsToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_caret_docs_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.caretDocsEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.caretDocsEnabled);
	}
}

export function updateAutoTriggerAutocompleteToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_auto_autocomplete_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.autoTriggerAutocompleteEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.autoTriggerAutocompleteEnabled);
	}
}

function toggleAutoTriggerAutocompleteEnabled() {
	_win.autoTriggerAutocompleteEnabled = !_win.autoTriggerAutocompleteEnabled;
	try { window.__kustoAutoTriggerAutocompleteEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateAutoTriggerAutocompleteToggleButtons();
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		(_win.vscode as any).postMessage({ type: 'setAutoTriggerAutocompleteEnabled', enabled: !!_win.autoTriggerAutocompleteEnabled });
	} catch (e) { console.error('[kusto]', e); }

	// When enabling, kick once for the currently focused editor (matches ADX feel).
	if (_win.autoTriggerAutocompleteEnabled) {
		try {
			const boxId = (typeof _win.activeQueryEditorBoxId === 'string') ? _win.activeQueryEditorBoxId : null;
			if (boxId && typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function updateCopilotInlineCompletionsToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_copilot_inline_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.copilotInlineCompletionsEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.copilotInlineCompletionsEnabled);
	}
}

function toggleCopilotInlineCompletionsEnabled() {
	_win.copilotInlineCompletionsEnabled = !_win.copilotInlineCompletionsEnabled;
	try { window.__kustoCopilotInlineCompletionsEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateCopilotInlineCompletionsToggleButtons();
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try {
		(_win.vscode as any).postMessage({ type: 'setCopilotInlineCompletionsEnabled', enabled: !!_win.copilotInlineCompletionsEnabled });
	} catch (e) { console.error('[kusto]', e); }
}

function toggleCaretDocsEnabled() {
	_win.caretDocsEnabled = !_win.caretDocsEnabled;
	updateCaretDocsToggleButtons();
	// Hide existing overlays immediately when turning off.
	if (!_win.caretDocsEnabled) {
		try {
			for (const key of Object.keys(_win.caretDocOverlaysByBoxId || {})) {
				const overlay = _win.caretDocOverlaysByBoxId[key];
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
			for (const boxId of _win.queryBoxes) {
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
			const overlays = (typeof _win.caretDocOverlaysByBoxId !== 'undefined') ? _win.caretDocOverlaysByBoxId : null;
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
		(_win.vscode as any).postMessage({ type: 'setCaretDocsEnabled', enabled: !!_win.caretDocsEnabled });
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// --- Toolbar action dispatcher ---

function onQueryEditorToolbarAction( boxId: any, action: any) {
	// Focus the editor so Monaco widgets (find/replace) attach correctly.
	try {
		_win.activeQueryEditorBoxId = boxId;
		if (_win.queryEditors[boxId]) {
			_win.queryEditors[boxId].focus();
		}
	} catch (e) { console.error('[kusto]', e); }

	if (action === 'undo') {
		try {
			const editor = _win.queryEditors[boxId];
			if (editor) {
				editor.trigger('toolbar', 'undo', null);
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'redo') {
		try {
			const editor = _win.queryEditors[boxId];
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
			if (_win.qualifyTablesInFlightByBoxId && _win.qualifyTablesInFlightByBoxId[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try { _win.qualifyTablesInFlightByBoxId[boxId] = true; } catch (e) { console.error('[kusto]', e); }
		try { setToolbarActionBusy(boxId, 'qualifyTables', true); } catch (e) { console.error('[kusto]', e); }
		(async () => {
			try {
				await fullyQualifyTablesInEditor(boxId);
			} finally {
				try { _win.qualifyTablesInFlightByBoxId[boxId] = false; } catch (e) { console.error('[kusto]', e); }
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

	const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
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
						(_win.vscode as any).postMessage({
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
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
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
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'There is no query text to share.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!String(connectionId || '').trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select a cluster connection first.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!String(database || '').trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select a database first.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	try {
		(_win.vscode as any).postMessage({
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
function __kustoOpenShareModal( boxId: any) {
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
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
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
		const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
		const hasQuery = !!(editor && String(editor.getValue() || '').trim());
		queryCheck.checked = hasQuery;
		queryCheck.disabled = !hasQuery;
	}

	// Show the modal.
	modal.classList.add('visible');
}

function __kustoCloseShareModal( event?: any) {
	if (event && event.target && event.target.id !== 'shareModal') return;
	const modal = document.getElementById('shareModal') as any;
	if (modal) modal.classList.remove('visible');
}

function __kustoShareCopyToClipboard() {
	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;
	const boxId = modal.dataset.boxId;
	if (!boxId) return;

	const includeTitle = !!(document.getElementById('shareModal_chk_title') as any || {}).checked;
	const includeQuery = !!(document.getElementById('shareModal_chk_query') as any || {}).checked;
	const includeResults = !!(document.getElementById('shareModal_chk_results') as any || {}).checked;

	if (!includeTitle && !includeQuery && !includeResults) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select at least one section to share.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	// Gather query text.
	let queryText = '';
	try {
		const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
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
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
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
						const formatted = (typeof _win.__kustoFormatCellDisplayValueForTable === 'function')
							? _win.__kustoFormatCellDisplayValueForTable(displayValue)
							: String(displayValue ?? '');
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
		(_win.vscode as any).postMessage({
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
		// reflect the busy state on the tools dropdown button.
		if (!btn && action === 'qualifyTables') {
			const toolsBtn = document.getElementById(boxId + '_tools_btn') as any;
			if (!toolsBtn) return;
			try {
				const icon = toolsBtn.querySelector('.qe-tools-icon');
				const caret = toolsBtn.querySelector('.qe-toolbar-caret');
				const spinner = toolsBtn.querySelector('.qe-tools-spinner');
				if (busy) {
					toolsBtn.classList.add('is-busy');
					toolsBtn.setAttribute('aria-busy', 'true');
					if (icon) icon.style.display = 'none';
					if (caret) caret.style.display = 'none';
					if (spinner) spinner.style.display = '';
				} else {
					toolsBtn.classList.remove('is-busy');
					toolsBtn.removeAttribute('aria-busy');
					if (icon) icon.style.display = '';
					if (caret) caret.style.display = '';
					if (spinner) spinner.style.display = 'none';
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// --- Tools dropdown ---

function closeToolsDropdown( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		closeMenuDropdown(id + '_tools_btn', id + '_tools_menu');
		return;
	} catch (e) { console.error('[kusto]', e); }
	try {
		const menu = document.getElementById(id + '_tools_menu') as any;
		if (menu) menu.style.display = 'none';
	} catch (e) { console.error('[kusto]', e); }
	try {
		const btn = document.getElementById(id + '_tools_btn') as any;
		if (btn) {
			btn.setAttribute('aria-expanded', 'false');
			try { btn.classList && btn.classList.remove('is-active'); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// --- Toolbar overflow handling ---
// Track ResizeObservers per toolbar
const __kustoToolbarResizeObservers: any = {};
// Track ResizeObservers for run button responsiveness
const __kustoRunBtnResizeObservers: any = {};

/**
 * Initialize toolbar overflow detection for a query box.
 * Uses ResizeObserver to detect when buttons overflow and shows a "..." menu.
 */
export function initToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	if (!toolbar) return;

	// Clean up any existing observer
	if (__kustoToolbarResizeObservers[id]) {
		try { __kustoToolbarResizeObservers[id].disconnect(); } catch (e) { console.error('[kusto]', e); }
	}

	// Create new observer
	const observer = new ResizeObserver(() => {
		try { updateToolbarOverflow(id); } catch (e) { console.error('[kusto]', e); }
	});
	observer.observe(toolbar);
	__kustoToolbarResizeObservers[id] = observer;

	// Initial check
	requestAnimationFrame(() => {
		try { updateToolbarOverflow(id); } catch (e) { console.error('[kusto]', e); }
	});

	// Also initialize run button responsiveness
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

/**
 * Update overflow state for a toolbar - hide overflowing items and show overflow menu
 */
function updateToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	const itemsContainer = toolbar && toolbar.querySelector('.qe-toolbar-items');
	const overflowWrapper = document.getElementById(id + '_toolbar_overflow_wrapper') as any;
	if (!toolbar || !itemsContainer || !overflowWrapper) return;

	// Get all toolbar items (buttons, separators, wrappers)
	const items = Array.from(itemsContainer.children) as any[];
	if (!items.length) return;

	// First, make all items visible to measure properly
	items.forEach((item: any) => item.classList.remove('qe-in-overflow'));
	overflowWrapper.classList.remove('is-visible');

	// Get available width (toolbar width minus padding and overflow button width)
	const toolbarStyle = getComputedStyle(toolbar);
	const paddingLeft = parseFloat(toolbarStyle.paddingLeft) || 0;
	const paddingRight = parseFloat(toolbarStyle.paddingRight) || 0;
	const gap = parseFloat(getComputedStyle(itemsContainer).gap) || 4;
	const overflowBtnWidth = 36; // Approximate width of overflow button
	const availableWidth = toolbar.clientWidth - paddingLeft - paddingRight - overflowBtnWidth - gap;

	// Calculate cumulative widths to find where overflow starts
	let totalWidth = 0;
	let overflowStartIndex = -1;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const itemWidth = item.offsetWidth + (i > 0 ? gap : 0);
		totalWidth += itemWidth;

		if (totalWidth > availableWidth && overflowStartIndex === -1) {
			// Find the previous separator to make a clean break
			let breakIndex = i;
			for (let j = i - 1; j >= 0; j--) {
				if (items[j].classList.contains('query-editor-toolbar-sep')) {
					breakIndex = j;
					break;
				}
			}
			overflowStartIndex = breakIndex;
			break;
		}
	}

	// If everything fits, no overflow needed
	if (overflowStartIndex === -1) {
		return;
	}

	// Hide items that overflow
	for (let i = overflowStartIndex; i < items.length; i++) {
		items[i].classList.add('qe-in-overflow');
	}

	// Show the overflow button
	overflowWrapper.classList.add('is-visible');
}

/**
 * Toggle the toolbar overflow menu
 */
function toggleToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	const btn = document.getElementById(id + '_toolbar_overflow_btn') as any;
	if (!menu || !btn) return;

	const isOpen = menu.style.display === 'block';

	// Close all other menus first
	try { closeAllRunMenus(); } catch (e) { console.error('[kusto]', e); }
	try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
	try { closeToolsDropdown(id); } catch (e) { console.error('[kusto]', e); }

	if (isOpen) {
		closeToolbarOverflow(id);
	} else {
		// Render the menu content
		renderToolbarOverflowMenu(id);
		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		btn.classList.add('is-active');

		// Position the menu using fixed positioning (to escape overflow:hidden)
		try {
			const btnRect = btn.getBoundingClientRect();
			const menuRect = menu.getBoundingClientRect();
			const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
			
			// Start with left-aligned to button
			let left = btnRect.left;
			
			// If menu would overflow right edge, align to right edge of button instead
			if (left + menuRect.width > viewportWidth - 8) {
				left = btnRect.right - menuRect.width;
			}
			
			// Ensure it doesn't go off the left edge either
			if (left < 8) {
				left = 8;
			}
			
			menu.style.left = left + 'px';
			menu.style.top = btnRect.bottom + 'px';
		} catch (e) { console.error('[kusto]', e); }

		// Wire keyboard nav if available
		try { wireMenuInteractions(menu); } catch (e) { console.error('[kusto]', e); }
	}
}

/**
 * Toggle overflow submenu (accordion style)
 */
function toggleOverflowSubmenu( element: any, event: any) {
	if (event) {
		event.stopPropagation();
	}
	if (!element) return;
	
	const isExpanded = element.getAttribute('aria-expanded') === 'true';
	const submenuItems = element.nextElementSibling;
	
	if (submenuItems && submenuItems.classList.contains('qe-toolbar-overflow-submenu-items')) {
		if (isExpanded) {
			element.setAttribute('aria-expanded', 'false');
			submenuItems.classList.remove('is-expanded');
		} else {
			element.setAttribute('aria-expanded', 'true');
			submenuItems.classList.add('is-expanded');
		}
	}
}

/**
 * Close the toolbar overflow menu
 */
function closeToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	const btn = document.getElementById(id + '_toolbar_overflow_btn') as any;
	if (menu) menu.style.display = 'none';
	if (btn) {
		btn.setAttribute('aria-expanded', 'false');
		btn.classList.remove('is-active');
	}
}

/**
 * Close all toolbar overflow menus
 */
function closeAllToolbarOverflowMenus() {
	document.querySelectorAll('.qe-toolbar-overflow-menu').forEach((menu: any) =>  {
		menu.style.display = 'none';
	});
	document.querySelectorAll('.qe-toolbar-overflow-btn').forEach((btn: any) =>  {
		btn.setAttribute('aria-expanded', 'false');
		btn.classList.remove('is-active');
	});
}

/**
 * Render the overflow menu items based on which buttons are hidden
 */
function renderToolbarOverflowMenu( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	if (!toolbar || !menu) return;

	const itemsContainer = toolbar.querySelector('.qe-toolbar-items');
	if (!itemsContainer) return;

	// Find all hidden items (those with qe-in-overflow class)
	const hiddenItems = Array.from(itemsContainer.querySelectorAll('.qe-in-overflow'));
	if (!hiddenItems.length) {
		menu.innerHTML = '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
		return;
	}

	// Checkmark SVG for active toggle items
	const checkmarkSvg = '<svg class="qe-overflow-checkmark" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>';
	const emptyCheckmarkPlaceholder = '<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>';

	// Tools submenu icons (same as in renderToolsMenuForBox)
	const __toolsDoubleToSingleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';
	const __toolsSingleToDoubleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';
	const __toolsQualifyTablesIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/>' +
		'</svg>';
	const __toolsSingleLineIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 8h12"/>' +
		'</svg>';
	const submenuArrowSvg = '<svg class="qe-overflow-submenu-arrow" viewBox="0 0 8 8" width="8" height="8" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	let menuHtml = '';
	let prevWasSep = false;
	let hasAnyToggleItem = false;

	// First pass: check if there are any toggle items so we know if we need the checkmark column
	hiddenItems.forEach((item: any) =>  {
		if (item.classList.contains('query-editor-toolbar-toggle')) {
			hasAnyToggleItem = true;
		}
	});

	hiddenItems.forEach((item: any) =>  {
		if (item.classList.contains('query-editor-toolbar-sep')) {
			// Add separator in menu (but avoid consecutive separators)
			if (!prevWasSep && menuHtml) {
				menuHtml += '<div class="qe-toolbar-overflow-sep"></div>';
				prevWasSep = true;
			}
			return;
		}
		prevWasSep = false;

		// Handle the tools dropdown specially - render as expandable accordion
		if (item.classList.contains('qe-toolbar-menu-wrapper')) {
			const toolsSubmenuHtml =
				'<div class="qe-toolbar-overflow-submenu-items">' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsDoubleToSingleIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Replace &quot; with &#39;</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsSingleToDoubleIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Replace &#39; with &quot;</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsQualifyTablesIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Fully qualify tables</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'singleLine\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsSingleLineIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Copy query as single line</span>' +
					'</div>' +
				'</div>';
			menuHtml += '<div class="qe-toolbar-overflow-item qe-overflow-has-submenu" role="menuitem" tabindex="-1" aria-expanded="false" onclick="toggleOverflowSubmenu(this, event);">' +
				(hasAnyToggleItem ? emptyCheckmarkPlaceholder : '') +
				'<span class="qe-icon" aria-hidden="true"><span class="codicon codicon-tools"></span></span>' +
				'<span class="qe-toolbar-overflow-label">Tools</span>' +
				submenuArrowSvg +
				'</div>' +
				toolsSubmenuHtml;
			return;
		}

		// Get action and label from data attributes or title
		const action = item.getAttribute('data-qe-overflow-action') || '';
		const label = item.getAttribute('data-qe-overflow-label') || item.getAttribute('title') || action;
		const iconHtml = item.querySelector('.qe-icon') ? item.querySelector('.qe-icon').innerHTML : '';
		const isDisabled = item.disabled || item.getAttribute('aria-disabled') === 'true';
		const isToggle = item.classList.contains('query-editor-toolbar-toggle');
		const isActive = item.classList.contains('is-active');

		if (action && label) {
			const disabledAttr = isDisabled ? ' style="opacity:0.5;cursor:default;" aria-disabled="true"' : '';
			const activeClass = isActive ? ' qe-overflow-item-active' : '';
			let onclick = '';
			if (!isDisabled) {
				if (action === 'caretDocs') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleCaretDocsEnabled();';
				} else if (action === 'autoAutocomplete') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleAutoTriggerAutocompleteEnabled();';
				} else if (action === 'copilotInline') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleCopilotInlineCompletionsEnabled();';
				} else if (action === 'copilotChat') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); __kustoToggleCopilotChatForBox(\'' + id + '\');';
				} else {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'' + action + '\');';
				}
			}
			// Add checkmark indicator for toggle items
			const checkmarkHtml = hasAnyToggleItem ? (isToggle && isActive ? checkmarkSvg : emptyCheckmarkPlaceholder) : '';
			menuHtml += '<div class="qe-toolbar-overflow-item' + activeClass + '" role="menuitem" tabindex="-1"' + disabledAttr + ' onclick="' + onclick + '">' +
				checkmarkHtml +
				'<span class="qe-icon" aria-hidden="true">' + iconHtml + '</span>' +
				'<span class="qe-toolbar-overflow-label">' + label + '</span>' +
				'</div>';
		}
	});

	// Remove trailing separator if any
	menuHtml = menuHtml.replace(/<div class="qe-toolbar-overflow-sep"><\/div>$/, '');

	menu.innerHTML = menuHtml || '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
}

function toggleToolsDropdown( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu') as any;
	const btn = document.getElementById(id + '_tools_btn') as any;
	if (!menu || !btn) return;

	try {
		toggleMenuDropdown({
			buttonId: id + '_tools_btn',
			menuId: id + '_tools_menu',
			beforeOpen: () => {
				try { renderToolsMenuForBox(id); } catch (e) { console.error('[kusto]', e); }
			},
			afterOpen: () => {
				// Shared dropdown helper wires keyboard navigation.
			}
		});
		return;
	} catch (e) { console.error('[kusto]', e); }

	// Fallback (legacy behavior)
	const next = menu.style.display === 'block' ? 'none' : 'block';
	try { closeAllRunMenus(); } catch (e) { console.error('[kusto]', e); }
	try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
	if (next === 'block') {
		try { renderToolsMenuForBox(id); } catch (e) { console.error('[kusto]', e); }
	}
	menu.style.display = next;
	btn.setAttribute('aria-expanded', next === 'block' ? 'true' : 'false');
	try {
		if (next === 'block') {
			btn.classList && btn.classList.add('is-active');
		} else {
			btn.classList && btn.classList.remove('is-active');
		}
	} catch (e) { console.error('[kusto]', e); }
	if (next === 'block') {
		try { wireMenuInteractions(menu); } catch (e) { console.error('[kusto]', e); }
		try { menu.focus(); } catch (e) { console.error('[kusto]', e); }
	}
}

function renderToolsMenuForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu') as any;
	if (!menu) return;

	// IMPORTANT: keep icons local here.
	// The toolbar HTML builder defines some SVG consts in a different scope; referencing them here can
	// throw at runtime and prevent the menu from rendering/opening.
	const __toolsDoubleToSingleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const __toolsSingleToDoubleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const __toolsQualifyTablesIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/>' +
		'</svg>';

	const __toolsSingleLineIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 8h12"/>' +
		'</svg>';

	const toolsItemHtml = (iconSvg: any, labelText: any) => {
		return (
			'<span class="qe-icon" aria-hidden="true">' + String(iconSvg || '') + '</span>' +
			'<span class="qe-toolbar-menu-label">' + String(labelText || '') + '</span>'
		);
	};

	const items = [
		{ key: 'doubleToSingle', html: toolsItemHtml(__toolsDoubleToSingleIconSvg, 'Replace &quot; with &#39;'), ariaLabel: 'Replace " with \'', selected: false },
		{ key: 'singleToDouble', html: toolsItemHtml(__toolsSingleToDoubleIconSvg, 'Replace &#39; with &quot;'), ariaLabel: 'Replace \' with "', selected: false },
		{ key: 'qualifyTables', html: toolsItemHtml(__toolsQualifyTablesIconSvg, 'Fully qualify tables'), ariaLabel: 'Fully qualify tables', selected: false },
		{ key: 'singleLine', html: toolsItemHtml(__toolsSingleLineIconSvg, 'Copy query as single line'), ariaLabel: 'Copy query as single line', selected: false }
	];

	try {
		menu.innerHTML = renderMenuItemsHtml(items, {
			dropdownId: id + '_tools',
			onSelectJs: (keyEnc: any) => {
				return (
					"onQueryEditorToolbarAction('" + id + "', '" + keyEnc + "');" +
					" try{window.__kustoDropdown&&window.__kustoDropdown.closeMenuDropdown&&window.__kustoDropdown.closeMenuDropdown('" + id + "_tools_btn','" + id + "_tools_menu')}catch{}"
				);
			}
		});
		return;
	} catch (e) { console.error('[kusto]', e); }

	// Minimal fallback markup (should rarely be used)
	menu.innerHTML = [
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsDoubleToSingleIconSvg, 'Replace &quot; with &#39;') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsSingleToDoubleIconSvg, 'Replace &#39; with &quot;') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsQualifyTablesIconSvg, 'Fully qualify tables') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleLine\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsSingleLineIconSvg, 'Copy query as single line') + '</div></div>'
	].join('');
}

// --- Monaco / editor helpers ---

function runMonacoAction( boxId: any, actionId: any) {
	const editor = _win.queryEditors[boxId];
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
	const editor = _win.queryEditors[boxId];
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
	const editor = _win.queryEditors[boxId];
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
					(_win.vscode as any).postMessage({
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
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}
	const conn = (_win.connections || []).find((c: any) => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch (e) { console.error('[kusto]', e); }
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
				(_win.vscode as any).postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
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
			(_win.vscode as any).postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
		} catch (e) { console.error('[kusto]', e); }
	} catch {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to copy Power BI query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
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
	return _win.runModesByBoxId[boxId] || 'take100';
}

// getRunModeLabelText imported from ../shared/comparisonUtils.ts

export function setRunMode( boxId: any, mode: any) {
	_win.runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	if (runBtn) {
		const labelSpan = runBtn.querySelector('.run-btn-label');
		const labelText = getRunModeLabelText(_win.runModesByBoxId[boxId]);
		if (labelSpan) {
			labelSpan.textContent = ' ' + labelText;
		}
		// Update tooltip
		const isEnabled = !runBtn.disabled;
		runBtn.title = labelText + (isEnabled ? '' : '\nSelect a cluster and database first (or select a favorite)');
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function closeRunMenu( boxId: any) {
	const menu = document.getElementById(boxId + '_run_menu') as any;
	if (menu) {
		menu.style.display = 'none';
	}
}

function closeAllRunMenus() {
	if (!_win.queryBoxes) return;
	_win.queryBoxes.forEach((id: any) => closeRunMenu(id));
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
	try { window.__kustoDropdown?.closeAllMenus?.(); } catch (e) { console.error('[kusto]', e); }
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
		if (Math.abs(scrollY - (typeof window.__kustoToolbarScrollAtOpen === 'number' ? window.__kustoToolbarScrollAtOpen : 0)) > 20) {
			window.__kustoDropdown?.closeAllMenus?.();
		}
	} catch (e) { console.error('[kusto]', e); }
}, true); // Use capture to catch scroll events on nested scrollable elements

document.addEventListener('wheel', (ev: any) => {
	// Allow scrolling inside dropdown menus without dismissing them.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	// Run menus are ephemeral — close immediately on wheel
	closeAllRunMenus();
	// Legacy dropdown menus also close on wheel (users expect wheel to dismiss)
	try { window.__kustoDropdown?.closeAllMenus?.(); } catch (e) { console.error('[kusto]', e); }
}, { passive: true });

// ── Window bridges for remaining legacy callers ──
window.updateCaretDocsToggleButtons = updateCaretDocsToggleButtons;
window.updateAutoTriggerAutocompleteToggleButtons = updateAutoTriggerAutocompleteToggleButtons;
window.toggleAutoTriggerAutocompleteEnabled = toggleAutoTriggerAutocompleteEnabled;
window.toggleCopilotInlineCompletionsEnabled = toggleCopilotInlineCompletionsEnabled;
window.toggleCaretDocsEnabled = toggleCaretDocsEnabled;
window.onQueryEditorToolbarAction = onQueryEditorToolbarAction;
window.__kustoOpenShareModal = __kustoOpenShareModal;
window.__kustoCloseShareModal = __kustoCloseShareModal;
window.__kustoShareCopyToClipboard = __kustoShareCopyToClipboard;
window.closeToolsDropdown = closeToolsDropdown;
window.initToolbarOverflow = initToolbarOverflow;
window.toggleToolbarOverflow = toggleToolbarOverflow;
window.toggleOverflowSubmenu = toggleOverflowSubmenu;
window.closeToolbarOverflow = closeToolbarOverflow;
window.toggleToolsDropdown = toggleToolsDropdown;
window.__kustoApplyRunModeFromMenu = __kustoApplyRunModeFromMenu;
window.getRunMode = getRunMode;
window.setRunMode = setRunMode;
window.closeAllRunMenus = closeAllRunMenus;
window.toggleRunMenu = toggleRunMenu;
