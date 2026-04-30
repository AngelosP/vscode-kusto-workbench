/**
 * `<kw-query-toolbar>` — Light-DOM Lit element for the query editor toolbar.
 *
 * Renders the toolbar buttons (undo, redo, prettify, tools, search, replace,
 * toggle buttons, export, link) with reactive state and @click bindings,
 * replacing the legacy innerHTML + onclick="window.__kustoXxx()" pattern.
 *
 * Uses **light DOM** (no shadow root) so existing CSS from queryEditor.css
 * applies unchanged, and document.getElementById() works for external callers.
 */
import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { KwMonacoToolbar, type MonacoToolbarItem } from '../components/kw-monaco-toolbar.js';
import {
	undoIcon, redoIcon, prettifyIcon, commentIcon, searchIcon, replaceIcon,
	autocompleteIcon, ghostIcon, caretDocsIcon, powerBIIcon,
	toolsCodiconIcon, linkCodiconIcon,
	toolsDoubleToSingleIcon, toolsSingleToDoubleIcon, toolsQualifyTablesIcon,
	toolsSingleLineIcon, toolsInlineFunctionIcon, toolsRenameIcon,
} from '../shared/icon-registry.js';
import { getRunModeLabelText } from '../shared/comparisonUtils.js';
import { __kustoHasFunctionDefinition } from '../monaco/prettify.js';
import { postMessageToHost } from '../shared/webview-messages.js';
import { getResultsState } from '../core/results-state.js';
import {
	__kustoGetConnectionId,
	__kustoGetDatabase,
	__kustoGetSectionName,
	closeAllFavoritesDropdowns,
	fullyQualifyTablesInEditor,
	sqlBoxes,
} from '../core/section-factory.js';
import { executeQuery, __kustoIsRunSelectionReady } from './query-execution.controller.js';
import { closeAllMenus } from '../core/dropdown.js';
import { schedulePersist } from '../core/persistence.js';
import { registerPageScrollDismissable } from '../core/page-scroll-dismiss.js';
import {
	activeQueryEditorBoxId,
	caretDocOverlaysByBoxId,
	qualifyTablesInFlightByBoxId,
	runModesByBoxId,
	optimizationMetadataByBoxId,
	caretDocsEnabled,
	setCaretDocsEnabled,
	autoTriggerAutocompleteEnabled,
	setAutoTriggerAutocompleteEnabled,
	copilotInlineCompletionsEnabled,
	setCopilotInlineCompletionsEnabled,
	setActiveQueryEditorBoxId,
	queryBoxes,
	queryEditors,
	connections,
} from '../core/state.js';

// Toolbar runtime logic previously in modules/queryBoxes-toolbar.ts

export function updateCaretDocsToggleButtons(): void {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCaretDocsActive === 'function') {
				toolbar.setCaretDocsActive(!!caretDocsEnabled);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function updateAutoTriggerAutocompleteToggleButtons(): void {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setAutoCompleteActive === 'function') {
				toolbar.setAutoCompleteActive(!!autoTriggerAutocompleteEnabled);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	for (const boxId of sqlBoxes) {
		try {
			const toolbar = document.querySelector('kw-sql-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setAutoCompleteActive === 'function') {
				toolbar.setAutoCompleteActive(!!autoTriggerAutocompleteEnabled);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function toggleAutoTriggerAutocompleteEnabled(): void {
	setAutoTriggerAutocompleteEnabled(!autoTriggerAutocompleteEnabled);
	try { window.__kustoAutoTriggerAutocompleteEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateAutoTriggerAutocompleteToggleButtons();
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try { postMessageToHost({ type: 'setAutoTriggerAutocompleteEnabled', enabled: !!autoTriggerAutocompleteEnabled }); } catch (e) { console.error('[kusto]', e); }

	if (autoTriggerAutocompleteEnabled) {
		try {
			const boxId = (typeof activeQueryEditorBoxId === 'string') ? activeQueryEditorBoxId : null;
			if (boxId && typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function updateCopilotInlineCompletionsToggleButtons(): void {
	for (const boxId of queryBoxes) {
		try {
			const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCopilotInlineActive === 'function') {
				toolbar.setCopilotInlineActive(!!copilotInlineCompletionsEnabled);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	for (const boxId of sqlBoxes) {
		try {
			const toolbar = document.querySelector('kw-sql-toolbar[box-id="' + boxId + '"]') as any;
			if (toolbar && typeof toolbar.setCopilotInlineActive === 'function') {
				toolbar.setCopilotInlineActive(!!copilotInlineCompletionsEnabled);
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

export function toggleCopilotInlineCompletionsEnabled(): void {
	setCopilotInlineCompletionsEnabled(!copilotInlineCompletionsEnabled);
	try { window.__kustoCopilotInlineCompletionsEnabledUserSet = true; } catch (e) { console.error('[kusto]', e); }
	updateCopilotInlineCompletionsToggleButtons();
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	try { postMessageToHost({ type: 'setCopilotInlineCompletionsEnabled', enabled: !!copilotInlineCompletionsEnabled }); } catch (e) { console.error('[kusto]', e); }
}

export function toggleCaretDocsEnabled(): void {
	setCaretDocsEnabled(!caretDocsEnabled);
	updateCaretDocsToggleButtons();
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
		try {
			const watermarkTitle = 'Smart documentation';
			const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';
			for (const boxId of queryBoxes) {
				try {
					const banner = document.getElementById(boxId + '_caret_docs') as any;
					const text = document.getElementById(boxId + '_caret_docs_text') || banner;
					if (banner) banner.style.display = 'flex';
					if (text) {
						text.innerHTML =
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' +
							watermarkTitle +
							'</div>' +
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' +
							watermarkBody +
							'</div>';
						if (text.classList) text.classList.add('is-watermark');
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			const overlays = (typeof caretDocOverlaysByBoxId !== 'undefined') ? caretDocOverlaysByBoxId : null;
			if (overlays && typeof overlays === 'object') {
				for (const key of Object.keys(overlays)) {
					try {
						const o = overlays[key];
						if (o && typeof o.update === 'function') o.update();
					} catch (e) { console.error('[kusto]', e); }
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	try { postMessageToHost({ type: 'setCaretDocsEnabled', enabled: !!caretDocsEnabled }); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function onQueryEditorToolbarAction(boxId: any, action: any): void {
	try {
		setActiveQueryEditorBoxId(boxId);
		if (queryEditors[boxId]) queryEditors[boxId].focus();
	} catch (e) { console.error('[kusto]', e); }

	if (action === 'undo') {
		try {
			const editor = queryEditors[boxId];
			if (editor) editor.trigger('toolbar', 'undo', null);
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'redo') {
		try {
			const editor = queryEditors[boxId];
			if (editor) editor.trigger('toolbar', 'redo', null);
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'search') return runMonacoAction(boxId, 'actions.find');
	if (action === 'replace') return runMonacoAction(boxId, 'editor.action.startFindReplaceAction');
	if (action === 'prettify') {
		try {
			if (typeof window.__kustoPrettifyQueryForBoxId === 'function') {
				window.__kustoPrettifyQueryForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		return runMonacoAction(boxId, 'editor.action.formatDocument');
	}
	if (action === 'toggleComment') return runMonacoAction(boxId, 'editor.action.commentLine');
	if (action === 'singleLine') {
		try {
			if (typeof window.__kustoCopySingleLineQueryForBoxId === 'function') {
				window.__kustoCopySingleLineQueryForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	if (action === 'inlineFunction') {
		try {
			if (typeof window.__kustoCopyAsInlineFunctionForBoxId === 'function') {
				window.__kustoCopyAsInlineFunctionForBoxId(boxId);
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
		return;
	}
	if (action === 'rename') return runMonacoAction(boxId, 'editor.action.rename');
	if (action === 'doubleToSingle') return replaceAllInEditor(boxId, '"', "'");
	if (action === 'singleToDouble') return replaceAllInEditor(boxId, "'", '"');
	if (action === 'exportPowerBI') return void exportQueryToPowerBI(boxId);
	if (action === 'copyAdeLink') return copyQueryAsAdeLink(boxId);
	if (action === 'qualifyTables') {
		try {
			if (qualifyTablesInFlightByBoxId && qualifyTablesInFlightByBoxId[boxId]) return;
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
	}
}

function copyQueryAsAdeLink(boxId: any): void {
	const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	try {
		if (editor) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof window.__kustoGetStatementBlocksFromModel === 'function')
				? window.__kustoGetStatementBlocksFromModel(model)
				: [];
			if (blocks && blocks.length > 1) {
				const statement = (typeof window.__kustoExtractStatementTextAtCursor === 'function')
					? window.__kustoExtractStatementTextAtCursor(editor)
					: null;
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
	try {
		const meta = optimizationMetadataByBoxId[boxId];
		if (meta && meta.isComparison && meta.sourceBoxId) {
			const sourceBoxId = String(meta.sourceBoxId || '');
			const srcConnId = __kustoGetConnectionId(sourceBoxId);
			const srcDb = __kustoGetDatabase(sourceBoxId);
			if (srcConnId) connectionId = srcConnId;
			if (srcDb) database = srcDb;
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

	try { postMessageToHost({ type: 'copyAdeLink', query, connectionId, database, boxId }); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoOpenShareModal(boxId: any): void {
	if (!boxId) return;
	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;

	modal.dataset.boxId = boxId;
	const sectionName = __kustoGetSectionName(boxId);
	const titleEl = document.getElementById('shareModal_title') as any;
	if (titleEl) titleEl.textContent = sectionName || 'Kusto Query';

	const state = getResultsState(boxId);
	const hasResults = !!(state && Array.isArray(state.columns) && state.columns.length > 0 && Array.isArray(state.rows) && state.rows.length > 0);
	const totalRows = hasResults ? state.rows.length : 0;
	const resultsCheck = document.getElementById('shareModal_chk_results') as any;
	if (resultsCheck) {
		resultsCheck.checked = hasResults;
		resultsCheck.disabled = !hasResults;
	}
	const resultsLabel = document.getElementById('shareModal_label_results') as any;
	if (resultsLabel) resultsLabel.classList.toggle('share-modal-option-disabled', !hasResults);

	const rowLimitInput = document.getElementById('shareModal_rowLimit') as any;
	if (rowLimitInput) {
		rowLimitInput.max = String(totalRows || 200);
		rowLimitInput.value = String(Math.min(totalRows || 10, 10));
		rowLimitInput.disabled = !hasResults;
	}
	const rowLimitGroup = document.getElementById('shareModal_rowLimitGroup') as any;
	if (rowLimitGroup) rowLimitGroup.style.display = hasResults ? '' : 'none';
	const resultsSubtitle = document.getElementById('shareModal_results_subtitle') as any;
	if (resultsSubtitle) resultsSubtitle.textContent = 'Formatted as a table';
	const rowLimitTotal = document.getElementById('shareModal_rowLimitTotal') as any;
	if (rowLimitTotal) rowLimitTotal.textContent = 'of ' + totalRows.toLocaleString() + ' rows';

	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch (e) { console.error('[kusto]', e); }
	try {
		const meta = optimizationMetadataByBoxId[boxId];
		if (meta && meta.isComparison && meta.sourceBoxId) {
			const src = String(meta.sourceBoxId || '');
			const srcConnId = __kustoGetConnectionId(src);
			const srcDb = __kustoGetDatabase(src);
			if (srcConnId) connectionId = srcConnId;
			if (srcDb) database = srcDb;
		}
	} catch (e) { console.error('[kusto]', e); }

	const hasLink = !!(String(connectionId || '').trim() && String(database || '').trim());
	const linkCheck = document.getElementById('shareModal_chk_title') as any;
	if (linkCheck) {
		linkCheck.checked = hasLink;
		linkCheck.disabled = !hasLink;
	}
	const linkLabel = document.getElementById('shareModal_label_title') as any;
	if (linkLabel) linkLabel.classList.toggle('share-modal-option-disabled', !hasLink);

	const linkSubtitle = document.getElementById('shareModal_link_subtitle') as any;
	if (linkSubtitle) {
		linkSubtitle.textContent = hasLink ? 'Includes a Direct link to query (Azure Data Explorer)' : 'Select a cluster and database to include a link';
	}

	const queryCheck = document.getElementById('shareModal_chk_query') as any;
	if (queryCheck) {
		const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
		const hasQuery = !!(editor && String(editor.getValue() || '').trim());
		queryCheck.checked = hasQuery;
		queryCheck.disabled = !hasQuery;
	}

	modal.classList.add('visible');
}

export function __kustoCloseShareModal(event?: any): void {
	if (event && event.target && event.target.id !== 'shareModal') return;
	const modal = document.getElementById('shareModal') as any;
	if (modal) modal.classList.remove('visible');
}

export function __kustoShareCopyToClipboard(): void {
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

	let queryText = '';
	try {
		const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
		queryText = editor ? (editor.getValue() || '') : '';
	} catch (e) { console.error('[kusto]', e); }

	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch (e) { console.error('[kusto]', e); }
	try {
		const meta = optimizationMetadataByBoxId[boxId];
		if (meta && meta.isComparison && meta.sourceBoxId) {
			const src = String(meta.sourceBoxId || '');
			const srcConnId = __kustoGetConnectionId(src);
			const srcDb = __kustoGetDatabase(src);
			if (srcConnId) connectionId = srcConnId;
			if (srcDb) database = srcDb;
		}
	} catch (e) { console.error('[kusto]', e); }

	let columns: any[] = [];
	let rowsData: any[] = [];
	let totalRows = 0;
	if (includeResults) {
		try {
			const state = getResultsState(boxId);
			if (state && Array.isArray(state.columns) && Array.isArray(state.rows)) {
				columns = state.columns.map((c: any) => (c && typeof c === 'object' && c.name) ? String(c.name) : String(c ?? ''));
				totalRows = state.rows.length;
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

	let sectionName = '';
	try { sectionName = __kustoGetSectionName(boxId); } catch (e) { console.error('[kusto]', e); }

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

	__kustoCloseShareModal();
}

function setToolbarActionBusy(boxId: any, action: any, busy: any): void {
	try {
		const root = document.getElementById(boxId) as any;
		if (!root) return;
		const btn = root.querySelector('.query-editor-toolbar-btn[data-qe-action="' + action + '"]');
		if (btn) {
			if (busy) {
				if (!btn.dataset.qePrevHtml) btn.dataset.qePrevHtml = btn.innerHTML;
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

const __kustoRunBtnResizeObservers: Record<string, ResizeObserver> = {};

export function initToolbarOverflow(boxId: any): void {
	initRunButtonResponsive(boxId);
}

function initRunButtonResponsive(boxId: any): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;

	if (__kustoRunBtnResizeObservers[id]) {
		try { __kustoRunBtnResizeObservers[id].disconnect(); } catch (e) { console.error('[kusto]', e); }
	}

	const observer = new ResizeObserver(() => {
		try { updateRunButtonResponsive(id); } catch (e) { console.error('[kusto]', e); }
	});
	observer.observe(queryBox);
	__kustoRunBtnResizeObservers[id] = observer;

	requestAnimationFrame(() => {
		try { updateRunButtonResponsive(id); } catch (e) { console.error('[kusto]', e); }
	});
}

function updateRunButtonResponsive(boxId: any): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	if (!runBtn) return;
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;
	const boxWidth = queryBox.offsetWidth;
	if (boxWidth < 400) runBtn.classList.add('is-compact');
	else runBtn.classList.remove('is-compact');
}

function runMonacoAction(boxId: any, actionId: any): void {
	const editor = queryEditors[boxId];
	if (!editor) return;
	try {
		const action = editor.getAction(actionId);
		if (action && typeof action.run === 'function') {
			action.run();
		}
	} catch (e) { console.error('[kusto]', e); }
}

function replaceAllInEditor(boxId: any, from: any, to: any): void {
	const editor = queryEditors[boxId];
	if (!editor) return;
	const model = editor.getModel();
	if (!model) return;
	const value = model.getValue();
	if (!value) return;
	const next = value.split(from).join(to);
	if (next === value) return;
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch (e) { console.error('[kusto]', e); }
}

async function exportQueryToPowerBI(boxId: any): Promise<void> {
	const editor = queryEditors[boxId];
	if (!editor) return;
	const model = editor.getModel();
	if (!model) return;
	let query = model.getValue() || '';
	try {
		const blocks = (typeof window.__kustoGetStatementBlocksFromModel === 'function')
			? window.__kustoGetStatementBlocksFromModel(model)
			: [];
		if (blocks && blocks.length > 1) {
			const statement = (typeof window.__kustoExtractStatementTextAtCursor === 'function')
				? window.__kustoExtractStatementTextAtCursor(editor)
				: null;
			if (statement) query = statement;
			else {
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

	const trimmedQuery = (query || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
	const powerBIPrefix = 'set notruncation;\nset maxmemoryconsumptionperiterator=32212254720;\n';
	const normalizedQuery = powerBIPrefix + trimmedQuery;
	const escapeMString = (s: string) => s.replace(/"/g, '""');
	const indentedQuery = normalizedQuery.split('\n').map((l: string) => '        ' + escapeMString(l)).join('\n');
	const m =
		'let\n' +
		'    Query = "\n' +
		indentedQuery + '\n' +
		'    ",\n' +
		'    Source = AzureDataExplorer.Contents("' + escapeMString(clusterUrl) + '", "' + escapeMString(database) + '", Query)\n' +
		'in\n' +
		'    Source';

	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(m);
			try { postMessageToHost({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' }); } catch (e) { console.error('[kusto]', e); }
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

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
		if (!ok) throw new Error('copy failed');
		try { postMessageToHost({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' }); } catch (e) { console.error('[kusto]', e); }
	} catch {
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to copy Power BI query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
	}
}

function __kustoApplyRunModeFromMenu(boxId: any, mode: any): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	setRunMode(id, mode);
	try {
		if (__kustoIsRunSelectionReady(id)) {
			executeQuery(id, mode);
		}
	} catch (e) { console.error('[kusto]', e); }
	try { closeRunMenu(id); } catch (e) { console.error('[kusto]', e); }
}

export function getRunMode(boxId: any): string {
	return runModesByBoxId[boxId] || 'take100';
}

export function setRunMode(boxId: any, mode: any): void {
	runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	if (runBtn) {
		const labelSpan = runBtn.querySelector('.run-btn-label');
		const labelText = getRunModeLabelText(runModesByBoxId[boxId]);
		if (labelSpan) labelSpan.textContent = ' ' + labelText;
		const isEnabled = !runBtn.disabled;
		runBtn.title = labelText + (isEnabled ? '' : '\nSelect a cluster and database first (or select a favorite)');
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

let removeRunMenuScrollDismiss: (() => void) | null = null;
let activeRunMenuBoxId: string | null = null;

function cleanupRunMenuScrollDismiss(): void {
	if (removeRunMenuScrollDismiss) {
		removeRunMenuScrollDismiss();
		removeRunMenuScrollDismiss = null;
	}
	activeRunMenuBoxId = null;
}

export function closeRunMenu(boxId: any): void {
	const id = String(boxId || '').trim();
	if (activeRunMenuBoxId === id) cleanupRunMenuScrollDismiss();
	const menu = document.getElementById(id + '_run_menu') as any;
	if (menu) menu.style.display = 'none';
}

export function closeAllRunMenus(): void {
	cleanupRunMenuScrollDismiss();
	if (!queryBoxes) return;
	queryBoxes.forEach((id: any) => closeRunMenu(id));
}

export function toggleRunMenu(boxId: any): void {
	const id = String(boxId || '').trim();
	const menu = document.getElementById(id + '_run_menu') as any;
	if (!menu) return;
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	menu.style.display = next;
	if (next === 'block') {
		try {
			removeRunMenuScrollDismiss = registerPageScrollDismissable(() => closeAllRunMenus(), {
				dismissOnWheel: true,
				shouldDismiss: ({ event, kind }) => kind !== 'wheel' || !event.composedPath().includes(menu),
			});
			activeRunMenuBoxId = id;
		} catch (e) { console.error('[kusto]', e); }
	}
}

// ── Function definition detection (shared by Copy as Inline Function and Run Function) ──

const functionDetectedByBoxId: Record<string, boolean> = {};
export const functionRunDialogOpenByBoxId: Record<string, boolean> = {};

/**
 * Call on every content change (and initial load) for a query section box.
 * Detects whether the editor text contains a function-defining command and
 * auto-flips the run mode to `runFunction` on false→true transitions.
 */
export function updateFunctionDetection(boxId: any, text: any): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const prev = functionDetectedByBoxId[id] ?? false;
	const now = __kustoHasFunctionDefinition(text);
	if (now === prev) return; // no change — skip DOM work
	functionDetectedByBoxId[id] = now;

	// Show/hide the "Run Function" menu item.
	const menuItem = document.getElementById(id + '_run_menu_runFunction');
	if (menuItem) menuItem.style.display = now ? '' : 'none';

	// Auto-flip on state transitions.
	if (now && !prev) {
		setRunMode(id, 'runFunction');
	}
	if (!now && prev && getRunMode(id) === 'runFunction') {
		setRunMode(id, 'take100');
	}
}

/** Returns the user's "real" run mode for persistence (never `runFunction`). */
export function getRunModeForPersistence(boxId: any): string {
	const mode = getRunMode(boxId);
	return mode === 'runFunction' ? 'take100' : mode;
}

const __kustoEventIsInsideDropdownUi = (ev: any): boolean => {
	try {
		const t = ev && ev.target ? ev.target : null;
		if (!t || !t.closest) return false;
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
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
	try { closeAllMenus(); } catch (e) { console.error('[kusto]', e); }
});

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
window.closeRunMenu = closeRunMenu;
window.closeAllRunMenus = closeAllRunMenus;
window.getRunModeLabelText = getRunModeLabelText;
window.toggleRunMenu = toggleRunMenu;

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-query-toolbar')
export class KwQueryToolbar extends KwMonacoToolbar {

	// ── Toggle button reactive state ──────────────────────────────────────────
	@state() private _caretDocsActive = false;
	@state() private _autoCompleteActive = false;
	@state() private _copilotInlineActive = false;
	@state() private _copilotChatActive = false;
	@state() private _copilotChatEnabled = false;

	// ── Copilot logo URI ──────────────────────────────────────────────────────
	private _copilotLogoUri = '';

	// ── Tools busy state ──────────────────────────────────────────────────────
	@state() private _toolsBusy = false;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		try {
			this._copilotLogoUri = ((window as any).__kustoQueryEditorConfig && (window as any).__kustoQueryEditorConfig.copilotLogoUri)
				? String((window as any).__kustoQueryEditorConfig.copilotLogoUri)
				: '';
		} catch { /* ignore */ }
	}

	// ── Copilot icon (dynamic, depends on URI) ────────────────────────────────

	private get _copilotIcon() {
		return this._copilotLogoUri
			? html`<img class="copilot-logo" src=${this._copilotLogoUri} alt="" aria-hidden="true" />`
			: html`<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="10" height="9" rx="2" /><path d="M6 12v1" /><path d="M10 12v1" /><circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" /><path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" /></svg>`;
	}

	// ── Items (override from base class) ──────────────────────────────────────

	private get _toolsSubItems() {
		return [
			{ label: 'Replace " with \'', icon: toolsDoubleToSingleIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'doubleToSingle') },
			{ label: 'Replace \' with "', icon: toolsSingleToDoubleIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'singleToDouble') },
			{ label: 'Fully qualify tables', icon: toolsQualifyTablesIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'qualifyTables') },
			{ label: 'Copy query as single line', icon: toolsSingleLineIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'singleLine') },
			{ label: 'Copy as inline function', icon: toolsInlineFunctionIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'inlineFunction') },
			{ label: 'Rename (F2)', icon: toolsRenameIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'rename') },
		];
	}

	protected override _getItems(): MonacoToolbarItem[] {
		return [
			{ type: 'button', label: 'Undo', title: 'Undo (Ctrl+Z)', icon: undoIcon, extraClasses: 'qe-undo-btn', action: () => onQueryEditorToolbarAction(this.boxId, 'undo') },
			{ type: 'button', label: 'Redo', title: 'Redo (Ctrl+Y)', icon: redoIcon, extraClasses: 'qe-redo-btn', action: () => onQueryEditorToolbarAction(this.boxId, 'redo') },
			{ type: 'separator' },
			{ type: 'button', label: 'Prettify query', title: 'Prettify query\nApplies Kusto-aware formatting rules (summarize/where/function headers)', icon: prettifyIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'prettify') },
			{ type: 'button', label: 'Toggle comment', title: 'Toggle comment\nComment or uncomment the selected lines (Ctrl+/)', icon: commentIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'toggleComment') },
			{ type: 'submenu', label: 'Tools', title: 'Tools', icon: toolsCodiconIcon, subItems: this._toolsSubItems, busy: this._toolsBusy },
			{ type: 'separator' },
			{ type: 'button', label: 'Search', title: 'Search\nFind in the current query', icon: searchIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'search') },
			{ type: 'button', label: 'Search and replace', overflowLabel: 'Search and replace', title: 'Search and replace\nFind and replace in the current query', icon: replaceIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'replace') },
			{ type: 'separator' },
			{ type: 'toggle', toggleKey: 'autoComplete', label: 'Auto-completions as you type', idSuffix: '_auto_autocomplete_toggle', title: 'Automatically trigger schema-based completions dropdown as you type\nShortcut for manual trigger: CTRL + SPACE', icon: autocompleteIcon, isActive: this._autoCompleteActive, extraClasses: 'qe-auto-autocomplete-toggle', action: () => this._handleToggle('autoComplete') },
			{ type: 'toggle', toggleKey: 'copilotInline', label: 'Copilot inline suggestions', idSuffix: '_copilot_inline_toggle', title: 'Automatically trigger Copilot inline completions (ghost text) as you type\nShortcut for manual trigger: CTRL + SHIFT + SPACE', icon: ghostIcon, isActive: this._copilotInlineActive, extraClasses: 'qe-copilot-inline-toggle', action: () => this._handleToggle('copilotInline') },
			{ type: 'toggle', toggleKey: 'caretDocs', label: 'Smart documentation', idSuffix: '_caret_docs_toggle', title: 'Smart documentation\nShows Kusto documentation based on cursor placement (not on mouse hover; on actual cursor placement inside the editor)', icon: caretDocsIcon, isActive: this._caretDocsActive, action: () => this._handleToggle('caretDocs') },
			{ type: 'toggle', toggleKey: 'copilotChat', label: 'Toggle Copilot chat', overflowLabel: 'Copilot chat', idSuffix: '_copilot_chat_toggle', title: 'Copilot chat\nGenerate and run a query with GitHub Copilot', icon: this._copilotIcon, isActive: this._copilotChatActive, extraClasses: 'kusto-copilot-chat-toggle', disabled: !this._copilotChatEnabled, action: () => this._handleToggle('copilotChat') },
			{ type: 'separator' },
			{ type: 'button', label: 'Export to Power BI', title: 'Export to Power BI\nCopies a Power Query (M) snippet to your clipboard for pasting into Power BI', icon: powerBIIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'exportPowerBI') },
			{ type: 'button', label: 'Share query as link (Azure Data Explorer)', overflowLabel: 'Share query as link', title: 'Share query as link (Azure Data Explorer)\nCopies a shareable URL to your clipboard containing the cluster, database and active query', icon: linkCodiconIcon, action: () => onQueryEditorToolbarAction(this.boxId, 'copyAdeLink') },
		];
	}

	// ── Close sibling menus before opening toolbar menus ──────────────────

	protected override _onBeforeMenuOpen(): void {
		try { closeRunMenu(this.boxId); } catch (e) { console.error('[kusto]', e); }
		try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _handleToggle(toggleKey: string): void {
		if (toggleKey === 'caretDocs') toggleCaretDocsEnabled();
		else if (toggleKey === 'autoComplete') toggleAutoTriggerAutocompleteEnabled();
		else if (toggleKey === 'copilotInline') toggleCopilotInlineCompletionsEnabled();
		else if (toggleKey === 'copilotChat') {
			try {
				const kwEl = document.getElementById(this.boxId) as any;
				if (kwEl && typeof kwEl.toggleCopilotChat === 'function') kwEl.toggleCopilotChat();
			} catch (e) { console.error('[kusto]', e); }
		}
	}

	// ── Public API (called by legacy code) ────────────────────────────────────

	public setCaretDocsActive(active: boolean): void { this._caretDocsActive = active; }
	public setAutoCompleteActive(active: boolean): void { this._autoCompleteActive = active; }
	public setCopilotInlineActive(active: boolean): void { this._copilotInlineActive = active; }
	public setCopilotChatActive(active: boolean): void { this._copilotChatActive = active; }
	public setCopilotChatEnabled(enabled: boolean): void { this._copilotChatEnabled = enabled; }
	public setToolsBusy(busy: boolean): void { this._toolsBusy = busy; }
}
