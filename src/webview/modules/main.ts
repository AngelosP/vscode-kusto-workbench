// Main module — converted from legacy/main.js
// Message dispatcher, keyboard shortcuts, drag-and-drop.
// Window bridge exports at bottom for remaining legacy callers.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { buildSchemaInfo } from '../shared/schema-utils';
import { getResultsState, displayResultForBox, displayResult, displayCancelled, ensureResultsShownForTool } from './resultsState';
import { __kustoRenderErrorUx, __kustoDisplayBoxError } from './errorUtils';
import { closeAllMenus as _closeAllDropdownMenus } from './dropdown';
import { addQueryBox, __kustoGetQuerySectionElement, __kustoSetSectionName, __kustoGetConnectionId, __kustoGetDatabase, updateConnectionSelects, updateDatabaseSelect, onDatabasesError, parseKustoExplorerConnectionsXml, __kustoUpdateFavoritesUiForAllBoxes, __kustoTryAutoEnterFavoritesModeForAllBoxes, __kustoMaybeDefaultFirstBoxToFavoritesMode, __kustoOnConnectionsUpdated, schemaRequestTokenByBoxId } from './queryBoxes';
import { addMarkdownBox, __kustoMaximizeMarkdownBox, markdownBoxes, markdownEditors } from './extraBoxes-markdown';
import { addChartBox } from './extraBoxes-chart';
import { addTransformationBox } from './extraBoxes-transformation';
import { addPythonBox, addUrlBox, onPythonResult, onPythonError, __kustoRefreshAllDataSourceDropdowns, __kustoGetChartValidationStatus, pythonBoxes, urlBoxes } from './extraBoxes';
import { __kustoEnsureAllEditorsWritableSoon } from './monaco-writable';
import { updateCaretDocsToggleButtons, updateAutoTriggerAutocompleteToggleButtons, updateCopilotInlineCompletionsToggleButtons, setRunMode, __kustoCloseShareModal, __kustoShareCopyToClipboard } from './queryBoxes-toolbar';
import { executeQuery, setQueryExecuting, __kustoSetResultsVisible, __kustoSetLinkedOptimizationMode, displayComparisonSummary, optimizeQueryWithCopilot, __kustoSetOptimizeInProgress, __kustoUpdateOptimizeStatus, __kustoHideOptimizePromptForBox, __kustoApplyOptimizeQueryOptions } from './queryBoxes-execution';
import { schedulePersist, handleDocumentDataMessage, getKqlxState, __kustoSetCompatibilityMode, __kustoApplyDocumentCapabilities, __kustoRequestAddSection, __kustoOnQueryResult } from './persistence';
import { __kustoControlCommandDocCache, __kustoControlCommandDocPending, __kustoCrossClusterSchemas } from './monaco';
import {
	activeMonacoEditor, activeQueryEditorBoxId, setActiveQueryEditorBoxId,
	connections, setConnections, setLastConnectionId, setLastDatabase,
	kustoFavorites, setKustoFavorites, setLeaveNoTraceClusters,
	setCaretDocsEnabled, setAutoTriggerAutocompleteEnabled, setCopilotInlineCompletionsEnabled,
	setQueryBoxes,
	queryEditors, cachedDatabases, optimizationMetadataByBoxId,
	schemaByConnDb, schemaRequestResolversByBoxId, schemaByBoxId,
	schemaFetchInFlightByBoxId, databasesRequestResolversByBoxId,
	caretDocOverlaysByBoxId
} from './state';
export {};

const _win = window;
// VS Code can intercept Ctrl/Cmd+V in webviews; provide a reliable paste path for Monaco.
document.addEventListener('keydown', async (event: any) => {
	if (!(event.ctrlKey || event.metaKey) || (event.key !== 'v' && event.key !== 'V')) {
		return;
	}

	// Don't intercept paste when focus is inside a Monaco widget (find widget, etc.)
	// Let the browser handle paste for those input fields.
	try {
		const target = event.target;
		if (target && target.closest && (target.closest('.find-widget') || target.closest('.suggest-widget') || target.closest('.parameter-hints-widget'))) {
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Prefer whichever Monaco editor actually has focus.
	// Only intercept paste when the editor TEXT area has focus, not widget focus.
	// Widget focus (like find widget) should handle its own paste.
	let editor: any = null;
	try {
		if (activeMonacoEditor && typeof activeMonacoEditor.hasTextFocus === 'function') {
			const hasTextFocus = activeMonacoEditor.hasTextFocus();
			if (hasTextFocus) {
				editor = activeMonacoEditor;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Fallback for older behavior: if a query editor is focused, use it.
	if (!editor && activeQueryEditorBoxId) {
		const qe = queryEditors[activeQueryEditorBoxId];
		try {
			if (qe && typeof qe.hasTextFocus === 'function') {
				const hasTextFocus = qe.hasTextFocus();
				if (hasTextFocus) {
					editor = qe;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	if (!editor) {
		return;
	}

	// Prevent default immediately to avoid duplicate paste operations.
	// The browser's native paste would otherwise also fire and cause issues.
	event.preventDefault();
	event.stopPropagation();
	if (typeof event.stopImmediatePropagation === 'function') {
		event.stopImmediatePropagation();
	}

	try {
		const text = await navigator.clipboard.readText();
		if (typeof text !== 'string') {
			return;
		}
		const selection = editor.getSelection();
		if (selection) {
			editor.executeEdits('clipboard', [{ range: selection, text }]);
			editor.focus();
		}
	} catch (e: any) {
		// If clipboard read isn't permitted, we already prevented default,
		// so the operation simply does nothing. This is acceptable for security reasons.
	}
}, true);

// If the mouse is over a surface that *looks* scrollable (Monaco, CodeMirror, results tables)
// but currently has no vertical scrollbar, scroll the whole page instead.
// This keeps the notebook feel: wheel always scrolls the document unless there's actually
// something under the cursor that can scroll.
try {
	if (!window.__kustoWheelPassthroughInstalled) {
		window.__kustoWheelPassthroughInstalled = true;
		document.addEventListener('wheel', (event: any) => {
			try {
				if (!event || event.defaultPrevented) return;
				// Don't interfere with pinch-zoom/zoom gestures.
				if (event.ctrlKey || event.metaKey) return;
				const t = event.target;
				const el = (t && t.nodeType === 1) ? t : (t && t.parentElement ? t.parentElement : null);
				if (!el || !el.closest) return;

				// Only apply passthrough when the cursor is over one of our known scroll-capturing areas.
				const scrollSurface = el.closest('.monaco-scrollable-element, .CodeMirror-scroll, .table-container, .results-body');
				if (!scrollSurface) return;

				// If the surface actually has a vertical scrollbar, let it handle the wheel.
				const hasVScroll = (scrollSurface.scrollHeight > (scrollSurface.clientHeight + 1));
				if (hasVScroll) return;

				// Otherwise, scroll the page.
				const dy = (typeof event.deltaY === 'number' && Number.isFinite(event.deltaY)) ? event.deltaY : 0;
				const dx = (typeof event.deltaX === 'number' && Number.isFinite(event.deltaX)) ? event.deltaX : 0;
				if (!dy && !dx) return;
				try { window.scrollBy(dx, dy); } catch (e) { console.error('[kusto]', e); }
				try { event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
				try { event.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		}, { capture: true, passive: false });
	}
} catch (e) { console.error('[kusto]', e); }

// Close open modal dialogs on Escape.
// Only intercept Escape when a modal is visible, so we don't interfere with
// Monaco/editor keybindings during normal editing.
document.addEventListener('keydown', (event: any) => {
	try {
		if (!event || event.key !== 'Escape') {
			return;
		}

		let handled = false;

		// Diff View (Lit component)
		if (!handled) {
			try {
				const diffView = document.querySelector('kw-diff-view') as any;
				if (diffView && diffView.isVisible) {
					handled = true;
					diffView.close();
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		// Object Viewer (legacy global modal)
		try {
			const modal = document.getElementById('objectViewer') as any;
			if (modal && modal.classList && modal.classList.contains('visible')) {
				handled = true;
				modal.classList.remove('visible');
			}
		} catch (e) { console.error('[kusto]', e); }

		// Column Analysis
		if (!handled) {
			try {
				const modal = document.getElementById('columnAnalysisModal') as any;
				if (modal && modal.classList && modal.classList.contains('visible')) {
					handled = true;
					if (typeof window.closeColumnAnalysis === 'function') {
						window.closeColumnAnalysis();
					} else {
						modal.classList.remove('visible');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		// Column Filter popover
		if (!handled) {
			try {
				const modal = document.querySelector && document.querySelector('.kusto-filter-modal.visible');
				if (modal) {
					handled = true;
					if (typeof window.closeColumnFilterPopover === 'function') {
						window.closeColumnFilterPopover();
					} else {
						try { modal.remove(); } catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		// Sort dialog (per-results box)
		if (!handled) {
			try {
				const modal = document.querySelector && document.querySelector('.kusto-sort-modal.visible');
				if (modal) {
					handled = true;
					const suffix = '_sort_modal';
					const id = modal.id ? String(modal.id) : '';
					const boxId = id.endsWith(suffix) ? id.slice(0, -suffix.length) : '';
					if (boxId && typeof window.closeSortDialog === 'function') {
						window.closeSortDialog(boxId);
					} else {
						modal.classList.remove('visible');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		// Share Modal
		if (!handled) {
			try {
				const modal = document.getElementById('shareModal') as any;
				if (modal && modal.classList && modal.classList.contains('visible')) {
					handled = true;
					if (typeof window.__kustoCloseShareModal === 'function') {
						window.__kustoCloseShareModal();
					} else {
						modal.classList.remove('visible');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		}

		if (!handled) {
			return;
		}

		try { event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}, true);

// VS Code can intercept Ctrl/Cmd+Space in webviews; provide a reliable autocomplete path for Monaco.
document.addEventListener('keydown', (event: any) => {
	try {
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}
		// Prefer event.code when available; fall back to key.
		const isSpace = (event.code === 'Space') || (event.key === ' ');
		if (!isSpace) {
			return;
		}
		// Only handle when the key event originates from inside a Monaco editor.
		try {
			const t = event.target;
			if (!t || !t.closest || !t.closest('.monaco-editor')) {
				return;
			}
		} catch {
			return;
		}

		const editor = __kustoGetFocusedMonacoEditor();
		if (!editor) {
			return;
		}

		// We are handling it; avoid double-triggering Monaco keybindings.
		try { event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }

		// Prefer the shared helper so we keep the "hide if no suggestions" behavior.
		try {
			const boxId = editor.__kustoBoxId;
			if (boxId && typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}, true);

// VS Code can intercept Shift+Space in webviews; provide a reliable inline-suggestion trigger.
document.addEventListener('keydown', (event: any) => {
	try {
		if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		const isSpace = (event.code === 'Space') || (event.key === ' ');
		if (!isSpace) {
			return;
		}
		// Only handle when the key event originates from inside a Monaco editor.
		try {
			const t = event.target;
			if (!t || !t.closest || !t.closest('.monaco-editor')) {
				return;
			}
		} catch {
			return;
		}

		const editor = __kustoGetFocusedMonacoEditor();
		if (!editor) {
			return;
		}

		// We are handling it; avoid double-triggering Monaco keybindings.
		try { event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
		try { event.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }

		// Trigger Copilot inline suggestions (ghost text).
		// Try multiple approaches for robustness across Monaco versions.
		try {
			const action = editor.getAction('editor.action.inlineSuggest.trigger');
			if (action) {
				action.run().catch(() => { /* ignore */ });
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}, true);

// --- KQL language service bridge (webview -> extension host) ---
// Used to share a single semantic engine between the webview Monaco editor and VS Code text editors.
// If the bridge is unavailable or times out, callers should fall back to local heuristics.
let __kustoKqlLanguageRequestResolversById: any = {};

// --- Local resource URI resolver (webview -> extension host) ---
// Used to map markdown-relative paths (e.g. ./images/a.png) to webview-safe URIs.
let __kustoResourceUriRequestResolversById: any = {};

try {
	window.__kustoResolveResourceUri = async function (args: any) {
		const p = (args && typeof args.path === 'string') ? String(args.path) : '';
		const baseUri = (args && typeof args.baseUri === 'string') ? String(args.baseUri) : '';
		if (!p || !window.vscode) {
			return null;
		}
		const requestId = 'resuri_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 2000);
			} catch (e) { console.error('[kusto]', e); }

			__kustoResourceUriRequestResolversById[requestId] = {
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'resolveResourceUri',
					requestId,
					path: p,
					baseUri
				});
			} catch {
				try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

try {
	window.__kustoRequestKqlTableReferences = async function (args: any) {
		const text = (args && typeof args.text === 'string') ? args.text : '';
		const connectionId = (args && typeof args.connectionId === 'string') ? args.connectionId : '';
		const database = (args && typeof args.database === 'string') ? args.database : '';
		const boxId = (args && typeof args.boxId === 'string') ? args.boxId : '';
		if (!window.vscode) {
			return null;
		}
		const requestId = 'kqlreq_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 1500);
			} catch (e) { console.error('[kusto]', e); }

			__kustoKqlLanguageRequestResolversById[requestId] = {
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'kqlLanguageRequest',
					requestId,
					method: 'kusto/findTableReferences',
					params: { text, connectionId, database, boxId }
				});
			} catch {
				try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

function __kustoGetFocusedMonacoEditor() {
	// Prefer whichever Monaco editor actually has focus.
	let editor: any = null;
	try {
		if (activeMonacoEditor && typeof activeMonacoEditor.hasTextFocus === 'function') {
			const hasFocus = activeMonacoEditor.hasTextFocus() ||
				(typeof activeMonacoEditor.hasWidgetFocus === 'function' && activeMonacoEditor.hasWidgetFocus());
			if (hasFocus) {
				editor = activeMonacoEditor;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Fallback for older behavior: if a query editor is focused, use it.
	if (!editor && activeQueryEditorBoxId) {
		const qe = queryEditors[activeQueryEditorBoxId];
		try {
			if (qe && typeof qe.hasTextFocus === 'function') {
				const hasFocus = qe.hasTextFocus() || (typeof qe.hasWidgetFocus === 'function' && qe.hasWidgetFocus());
				if (hasFocus) {
					editor = qe;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
	}
	return editor;
}

// --- Toolbar focus behavior ---
// Goal: when the Monaco editor has focus and the user clicks toolbar buttons (normal, toggle,
// dropdown) with the mouse, don't leave focus on the button; return focus to Monaco.
// We do this in a central place because toolbar HTML is generated dynamically.
(function __kustoInitToolbarMouseFocusBehavior() {
	const focusEditorForTarget = (target: any) => {
		try {
			// Prefer focusing the editor for the query box that owns the toolbar/menu.
			const t = target && target.closest ? target : null;
			const box = t ? t.closest('.query-box') : null;
			const boxId = box && typeof box.id === 'string' ? box.id : '';
			if (boxId && queryEditors && queryEditors[boxId] && typeof queryEditors[boxId].focus === 'function') {
				try { setActiveQueryEditorBoxId(boxId); } catch (e) { console.error('[kusto]', e); }
				queryEditors[boxId].focus();
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		// Fallback: focus whichever Monaco editor is currently focused/active.
		try {
			const editor = (typeof __kustoGetFocusedMonacoEditor === 'function') ? __kustoGetFocusedMonacoEditor() : null;
			if (editor && typeof editor.focus === 'function') {
				editor.focus();
			}
		} catch (e) { console.error('[kusto]', e); }
	};

	// Prevent mouse focus from moving onto toolbar buttons.
	document.addEventListener('mousedown', (ev: any) => {
		try {
			const e = ev || window.event;
			if (!e || e.button !== 0) return;
			const t = e.target;
			if (!t || !t.closest) return;
			if (t.closest('.query-editor-toolbar') || t.closest('.qe-toolbar-dropdown-menu') || t.closest('.qe-toolbar-overflow-menu')) {
				// Prevent the browser from focusing the clicked element.
				e.preventDefault();
			}
		} catch (e) { console.error('[kusto]', e); }
	}, true);

	// After toolbar clicks, return focus to Monaco.
	// Important: do NOT do this for the dropdown *toggle* button itself, otherwise we would
	// immediately steal focus from the opened menu and close it.
	document.addEventListener('click', (ev: any) => {
		try {
			const e = ev || window.event;
			const t = e && e.target ? e.target : null;
			if (!t || !t.closest) return;

			const inToolbar = !!t.closest('.query-editor-toolbar');
			const inToolbarMenu = !!t.closest('.qe-toolbar-dropdown-menu');
			const inOverflowMenu = !!t.closest('.qe-toolbar-overflow-menu');
			if (!inToolbar && !inToolbarMenu && !inOverflowMenu) return;

			const isDropdownToggle = inToolbar && !!t.closest('.qe-toolbar-dropdown-btn');
			const isOverflowToggle = inToolbar && !!t.closest('.qe-toolbar-overflow-btn');
			if (isDropdownToggle || isOverflowToggle) {
				return;
			}

			setTimeout(() => focusEditorForTarget(t), 0);
		} catch (e) { console.error('[kusto]', e); }
	}, true);
})();

function __kustoGetSelectionOrCurrentLineRange( editor: any) {
	try {
		const selection = editor && typeof editor.getSelection === 'function' ? editor.getSelection() : null;
		// If we have a non-empty selection, use it.
		if (selection && (
			(typeof selection.isEmpty === 'function' && !selection.isEmpty()) ||
			(selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn)
		)) {
			return {
				startLineNumber: selection.startLineNumber,
				startColumn: selection.startColumn,
				endLineNumber: selection.endLineNumber,
				endColumn: selection.endColumn
			};
		}

		// Otherwise, mimic editor behavior: operate on the current line.
		const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
		const pos = editor && typeof editor.getPosition === 'function' ? editor.getPosition() : null;
		if (!model || !pos || typeof pos.lineNumber !== 'number') {
			return null;
		}
		const line = pos.lineNumber;
		const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : line;
		if (line < 1) {
			return null;
		}
		if (line < lineCount) {
			// Include the newline by selecting to the start of the next line.
			return { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 };
		}
		const endCol = typeof model.getLineMaxColumn === 'function' ? model.getLineMaxColumn(line) : 1;
		return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: endCol };
	} catch {
		return null;
	}
}

async function __kustoCopyOrCutFocusedMonaco( event: any, isCut: any) {
	const editor = __kustoGetFocusedMonacoEditor();
	if (!editor) {
		return;
	}
	await __kustoCopyOrCutMonacoEditorImpl(editor, event, isCut);
}

async function __kustoCopyOrCutMonacoEditorImpl( editor: any, eventOrNull: any, isCut: any) {
	if (!editor) {
		return false;
	}
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	if (!model || typeof model.getValueInRange !== 'function') {
		return false;
	}
	const range = __kustoGetSelectionOrCurrentLineRange(editor);
	if (!range) {
		return false;
	}
	let text = '';
	try {
		text = model.getValueInRange(range);
	} catch {
		return false;
	}
	if (typeof text !== 'string' || text.length === 0) {
		return false;
	}

	try {
		await navigator.clipboard.writeText(text);
		try {
			if (eventOrNull && typeof eventOrNull.preventDefault === 'function') {
				eventOrNull.preventDefault();
			}
			if (eventOrNull && typeof eventOrNull.stopPropagation === 'function') {
				eventOrNull.stopPropagation();
			}
			if (eventOrNull && typeof eventOrNull.stopImmediatePropagation === 'function') {
				eventOrNull.stopImmediatePropagation();
			}
		} catch (e) { console.error('[kusto]', e); }
		if (isCut) {
			try {
				editor.executeEdits('clipboard', [{ range, text: '' }]);
			} catch (e) { console.error('[kusto]', e); }
		}
		try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
		return true;
	} catch {
		// If clipboard write isn't permitted, fall back to default behavior.
		// (Do not preventDefault in this case.)
		return false;
	}
}

// Expose for Monaco context-menu action overrides.
try {
	window.__kustoCopyOrCutMonacoEditor = async function (editor: any, isCut: any) {
		return await __kustoCopyOrCutMonacoEditorImpl(editor, null, !!isCut);
	};
} catch (e) { console.error('[kusto]', e); }

// VS Code can intercept Ctrl/Cmd+X/C; provide reliable cut/copy paths for Monaco.
document.addEventListener('keydown', (event: any) => {
	if (!(event.ctrlKey || event.metaKey)) {
		return;
	}
	const editor = __kustoGetFocusedMonacoEditor();
	if (!editor) {
		return;
	}
	if (event.key === 'x' || event.key === 'X') {
		// Prevent default immediately so the native 'cut' event doesn't also fire
		// and cause a duplicate clipboard operation.
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === 'function') {
			event.stopImmediatePropagation();
		}
		void __kustoCopyOrCutFocusedMonaco(event, true);
		return;
	}
	if (event.key === 'c' || event.key === 'C') {
		// Prevent default immediately so the native 'copy' event doesn't also fire
		// and cause a duplicate clipboard operation.
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === 'function') {
			event.stopImmediatePropagation();
		}
		void __kustoCopyOrCutFocusedMonaco(event, false);
		return;
	}
}, true);

// Right-click context menu Cut/Copy often routes through these events.
// NOTE: These are intentionally NOT prevented above, because the keydown handler
// only prevents events when a Monaco editor has focus.
document.addEventListener('cut', (event: any) => {
	void __kustoCopyOrCutFocusedMonaco(event, true);
}, true);
document.addEventListener('copy', (event: any) => {
	void __kustoCopyOrCutFocusedMonaco(event, false);
}, true);

// Ctrl+Enter / Ctrl+Shift+Enter (Cmd+Enter / Cmd+Shift+Enter on macOS) runs the active query box,
// same as clicking the main run button. Also submits Copilot Chat if focused.
document.addEventListener('keydown', (event: any) => {
	// Some environments report Enter via `code` more reliably than `key`.
	const isEnter = (event.key === 'Enter') || (event.code === 'Enter');
	if (!(event.ctrlKey || event.metaKey) || !isEnter) {
		return;
	}
	if (!activeQueryEditorBoxId) {
		return;
	}

	// Don't execute if focus is inside a non-query section (Python, URL, markdown, etc.).
	const activeEl = document.activeElement as HTMLElement | null;
	try {
		if (activeEl && activeEl.closest) {
			if (activeEl.closest('kw-python-section, kw-url-section, kw-markdown-section, kw-chart-section, kw-transformation-section')) {
				return;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	// Also check event.target in case activeElement doesn't reflect the right element.
	try {
		const target = (event.target as HTMLElement);
		if (target && target.closest) {
			if (target.closest('kw-python-section, kw-url-section, kw-markdown-section, kw-chart-section, kw-transformation-section')) {
				return;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	if (activeEl && activeEl.id === activeQueryEditorBoxId + '_copilot_input') {
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === 'function') {
			event.stopImmediatePropagation();
		}
		try {
			const kwEl = activeQueryEditorBoxId ? __kustoGetQuerySectionElement(activeQueryEditorBoxId) : null;
			if (kwEl && typeof kwEl.copilotWriteQuerySend === 'function') {
				kwEl.copilotWriteQuerySend();
			}
		} catch (e) { console.error('[kusto]', e); }
		return;
	}

	// Prevent Monaco's default Ctrl/Cmd+Enter behavior (typically "insert line below")
	// from running in addition to executing the query.
	event.preventDefault();
	event.stopPropagation();
	if (typeof event.stopImmediatePropagation === 'function') {
		event.stopImmediatePropagation();
	}
	try {
		executeQuery(activeQueryEditorBoxId);
	} catch (e) { console.error('[kusto]', e); }
}, true);

// F1 should show the Monaco hover tooltip (docs) when inside the editor.
document.addEventListener('keydown', (event: any) => {
	if (event.key !== 'F1') {
		return;
	}
	if (!activeQueryEditorBoxId) {
		return;
	}
	const editor = queryEditors[activeQueryEditorBoxId];
	if (!editor) {
		return;
	}
	try {
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === 'function') {
			event.stopImmediatePropagation();
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		editor.trigger('keyboard', 'editor.action.showHover', {});
	} catch (e) { console.error('[kusto]', e); }
}, true);

// Escape hides the custom caret tooltip overlay (without interfering with Monaco default behavior).
document.addEventListener('keydown', (event: any) => {
	if (event.key !== 'Escape' && event.key !== 'Esc') {
		return;
	}
	try {
		if (activeQueryEditorBoxId && caretDocOverlaysByBoxId && caretDocOverlaysByBoxId[activeQueryEditorBoxId]) {
			const overlay = caretDocOverlaysByBoxId[activeQueryEditorBoxId];
			if (overlay && typeof overlay.hide === 'function') {
				overlay.hide();
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}, true);

// If the webview loses focus, hide any visible caret tooltip.
window.addEventListener('blur', () => {
	try {
		for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
			const overlay = caretDocOverlaysByBoxId[key];
			if (overlay && typeof overlay.hide === 'function') {
				overlay.hide();
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	// Also reset any stuck resize-drag interaction state.
	try {
		if (document && document.body) {
			if (document.body.style && document.body.style.userSelect === 'none') {
				document.body.style.userSelect = '';
			}
			if (document.body.style && document.body.style.cursor === 'ns-resize') {
				document.body.style.cursor = '';
			}
		}
		try {
			(document.querySelectorAll('.query-editor-resizer.is-dragging') || []).forEach((el: any) => el.classList.remove('is-dragging'));
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
});

// When the webview becomes active again, Monaco can occasionally end up with its hidden
// textarea stuck readonly/disabled. Re-assert writability for all editors.
window.addEventListener('focus', () => {
	try {
		__kustoEnsureAllEditorsWritableSoon();
	} catch (e) { console.error('[kusto]', e); }
});

document.addEventListener('visibilitychange', () => {
	try {
		if (!document.hidden) {
			__kustoEnsureAllEditorsWritableSoon();
		}
	} catch (e) { console.error('[kusto]', e); }
	// Reset any stuck drag state when the tab visibility changes.
	try {
		if (document && document.body) {
			if (document.body.style && document.body.style.userSelect === 'none') {
				document.body.style.userSelect = '';
			}
			if (document.body.style && document.body.style.cursor === 'ns-resize') {
				document.body.style.cursor = '';
			}
		}
		try {
			(document.querySelectorAll('.query-editor-resizer.is-dragging') || []).forEach((el: any) => el.classList.remove('is-dragging'));
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
});

window.addEventListener('message', async (event: any) => {
	const message = (event && event.data && typeof event.data === 'object') ? event.data : {};
	const messageType = String(message.type || '');
	switch (messageType) {
		case 'controlCommandSyntaxResult':
			try {
				const commandLower = String(message.commandLower || '').trim();
				if (commandLower) {
					try {
						const ok = !!message.ok;
						const syntax = ok && typeof message.syntax === 'string' ? String(message.syntax) : '';
						const withArgs = ok && Array.isArray(message.withArgs) ? message.withArgs.map((s: any) => String(s)) : [];
						__kustoControlCommandDocCache[commandLower] = {
							syntax,
							withArgs,
							fetchedAt: Date.now()
						};
					} catch (e) { console.error('[kusto]', e); }
					try {
						delete __kustoControlCommandDocPending[commandLower];
					} catch (e) { console.error('[kusto]', e); }
					try {
						if (typeof window.__kustoRefreshActiveCaretDocs === 'function') {
							window.__kustoRefreshActiveCaretDocs();
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'ensureComparisonBox':
			try {
				const boxId = String(message.boxId || '');
				const requestId = String(message.requestId || '');
				const query = (typeof message.query === 'string') ? message.query : '';
				if (!boxId || !requestId) {
					break;
				}
				let comparisonBoxId = '';
				try {
					comparisonBoxId = await optimizeQueryWithCopilot(boxId, query, { skipExecute: true });
				} catch (e) { console.error('[kusto]', e); }
				try {
					postMessageToHost({
						type: 'comparisonBoxEnsured',
						requestId,
						sourceBoxId: boxId,
						comparisonBoxId: String(comparisonBoxId || '')
					});
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'persistenceMode':
				try {
					pState.isSessionFile = !!message.isSessionFile;
					try {
						if (typeof message.documentUri === 'string') {
							pState.documentUri = String(message.documentUri);
						}
					} catch (e) { console.error('[kusto]', e); }
						try {
							if (typeof message.documentKind === 'string') {
								pState.documentKind = String(message.documentKind);
								try {
									if (document && document.body && document.body.dataset) {
										document.body.dataset.kustoDocumentKind = String(message.documentKind);
									}
								} catch (e) { console.error('[kusto]', e); }
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							if (Array.isArray(message.allowedSectionKinds)) {
								pState.allowedSectionKinds = message.allowedSectionKinds.map((k: any) => String(k));
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
						} catch (e) { console.error('[kusto]', e); }
						__kustoSetCompatibilityMode(!!message.compatibilityMode);
						try {
							__kustoApplyDocumentCapabilities();
						} catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				break;
		case 'upgradedToKqlx':
			// The extension host has upgraded the file format from .kql/.csl to .kqlx.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'enabledKqlxSidecar':
			// The extension host has enabled a companion .kqlx metadata file for a .kql/.csl document.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'connectionsData':
			setConnections(message.connections);
			try { window.connections = connections; } catch (e) { console.error('[kusto]', e); }
			setLastConnectionId(message.lastConnectionId);
			setLastDatabase(message.lastDatabase);
			for (const k of Object.keys(cachedDatabases)) delete cachedDatabases[k];
			Object.assign(cachedDatabases, message.cachedDatabases || {});
			setKustoFavorites(Array.isArray(message.favorites) ? message.favorites : []);
			setLeaveNoTraceClusters(Array.isArray(message.leaveNoTraceClusters) ? message.leaveNoTraceClusters : []);
			try { window.__kustoDevNotesEnabled = !!message.devNotesEnabled; } catch (e) { console.error('[kusto]', e); }
			try { pState.copilotChatFirstTimeDismissed = !!message.copilotChatFirstTimeDismissed; } catch (e) { console.error('[kusto]', e); }
			setCaretDocsEnabled((typeof message.caretDocsEnabled === 'boolean') ? message.caretDocsEnabled : true);
			setAutoTriggerAutocompleteEnabled((typeof message.autoTriggerAutocompleteEnabled === 'boolean') ? message.autoTriggerAutocompleteEnabled : true);
			setCopilotInlineCompletionsEnabled((typeof message.copilotInlineCompletionsEnabled === 'boolean') ? message.copilotInlineCompletionsEnabled : true);
			try {
				// Indicates whether the user has explicitly chosen a value (on/off) before.
				// When true, document-level restore should not override this global preference.
				window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			try {
				window.__kustoAutoTriggerAutocompleteEnabledUserSet = !!message.autoTriggerAutocompleteEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			try {
				window.__kustoCopilotInlineCompletionsEnabledUserSet = !!message.copilotInlineCompletionsEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			updateConnectionSelects();
			try {
				__kustoUpdateFavoritesUiForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoTryAutoEnterFavoritesModeForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoMaybeDefaultFirstBoxToFavoritesMode();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoOnConnectionsUpdated();
			} catch (e) { console.error('[kusto]', e); }
			try { updateCaretDocsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			try { updateCopilotInlineCompletionsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'updateDevNotes': {
			// Mutate passthrough dev notes sections from extension host (Copilot / agent tool calls)
			try {
				if (!Array.isArray(pState.devNotesSections)) {
					pState.devNotesSections = [];
				}
				const action = String(message.action || '');
				if (action === 'add') {
					// Ensure a single devnotes section exists
					let dn = pState.devNotesSections.find((s: any) => s && s.type === 'devnotes');
					if (!dn) {
						dn = { type: 'devnotes', id: 'devnotes_' + Date.now(), entries: [] };
						pState.devNotesSections.push(dn);
					}
					if (!Array.isArray(dn.entries)) dn.entries = [];
					// If superseding an existing entry, remove it first
					if (message.supersedes) {
						const sid = String(message.supersedes);
						dn.entries = dn.entries.filter((e: any) => e && String(e.id) !== sid);
					}
					if (message.entry && typeof message.entry === 'object') {
						dn.entries.push(message.entry);
					}
				} else if (action === 'remove') {
					const noteId = String(message.noteId || '');
					if (noteId) {
						for (const dn of pState.devNotesSections) {
							if (dn && Array.isArray(dn.entries)) {
								dn.entries = dn.entries.filter((e: any) => e && String(e.id) !== noteId);
							}
						}
					}
				}
				// Persist after mutation
				try { schedulePersist('devnotes-update'); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			// Respond to extension host if a requestId was provided
			try {
				if (message.requestId) {
					postMessageToHost({ type: 'updateDevNotesResponse', requestId: message.requestId, success: true });
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		}
		case 'favoritesData':
			setKustoFavorites(Array.isArray(message.favorites) ? message.favorites : []);
			try {
				__kustoUpdateFavoritesUiForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoTryAutoEnterFavoritesModeForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoMaybeDefaultFirstBoxToFavoritesMode();
			} catch (e) { console.error('[kusto]', e); }
			// If this update came from an "Add favorite" action in a specific box, automatically
			// switch that box into Favorites mode.
			try {
				const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
				if (boxId && Array.isArray(kustoFavorites) && kustoFavorites.length > 0) {
					if (typeof window.__kustoEnterFavoritesModeForBox === 'function') {
						window.__kustoEnterFavoritesModeForBox(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'confirmRemoveFavoriteResult':
			try {
				if (typeof window.__kustoOnConfirmRemoveFavoriteResult === 'function') {
					window.__kustoOnConfirmRemoveFavoriteResult(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'documentData':
			try {
				{
					handleDocumentDataMessage(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'revealTextRange':
			try {
				try {
					const s = message && message.start ? message.start : null;
					const e = message && message.end ? message.end : null;
					const sl = s && typeof s.line === 'number' ? s.line : 0;
					const sc = s && typeof s.character === 'number' ? s.character : 0;
					const el = e && typeof e.line === 'number' ? e.line : sl;
					const ec = e && typeof e.character === 'number' ? e.character : sc;
					const matchLen = (message && typeof message.matchText === 'string') ? String(message.matchText).length : 0;
					postMessageToHost({
						type: 'debugMdSearchReveal',
						phase: 'revealTextRange(received)',
						detail: `${String(message.documentUri || '')} ${sl}:${sc}-${el}:${ec} matchLen=${matchLen}`
					});
				} catch (e) { console.error('[kusto]', e); }
				if (typeof window.__kustoRevealTextRangeFromHost === 'function') {
					window.__kustoRevealTextRangeFromHost(message);
					try {
						postMessageToHost({
							type: 'debugMdSearchReveal',
							phase: 'revealTextRange(dispatched)',
							detail: `${String(message.documentUri || '')}`
						});
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'resolveResourceUriResult':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoResourceUriRequestResolversById && __kustoResourceUriRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					const uri = (message && message.ok && typeof message.uri === 'string') ? String(message.uri) : null;
					try { r.resolve(uri); } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoResourceUriRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kqlLanguageResponse':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoKqlLanguageRequestResolversById && __kustoKqlLanguageRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					try {
						r.resolve(message.ok ? (message.result || null) : null);
					} catch (e) { console.error('[kusto]', e); }
					try { delete __kustoKqlLanguageRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'databasesData':
			// Resolve pending database list request if this was a synthetic request id.
			try {
				const r = databasesRequestResolversByBoxId && databasesRequestResolversByBoxId[message.boxId];
				if (r && typeof r.resolve === 'function') {
					let cid = '';
					try {
						const prefix = '__kusto_dbreq__';
						const bid = String(message.boxId || '');
						if (bid.startsWith(prefix)) {
							const rest = bid.slice(prefix.length);
							const parts = rest.split('__');
							cid = parts && parts.length ? decodeURIComponent(parts[0]) : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					const list = (Array.isArray(message.databases) ? message.databases : [])
						.map((d: any) => String(d || '').trim())
						.filter(Boolean)
						.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));
					try {
						if (cid) {
							let clusterKey = '';
							try {
								const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '').trim() === String(cid || '').trim()) : null;
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
							if (clusterKey) {
								cachedDatabases[clusterKey] = list;
							}
						}
					} catch (e) { console.error('[kusto]', e); }
					try { r.resolve(list); } catch (e) { console.error('[kusto]', e); }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }

			updateDatabaseSelect(message.boxId, message.databases, message.connectionId);
			break;
		case 'databasesError':
			// Reject pending database list request if this was a synthetic request id.
			try {
				const r = databasesRequestResolversByBoxId && databasesRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message && message.error ? String(message.error) : 'Failed to load databases.')); } catch (e) { console.error('[kusto]', e); }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				onDatabasesError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.', message.connectionId);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'importConnectionsXmlText':
			try {
				const text = (typeof message.text === 'string') ? message.text : '';
				const imported = parseKustoExplorerConnectionsXml(text);
				if (!imported || !imported.length) {
					try { postMessageToHost({ type: 'showInfo', message: 'No connections found in the selected XML file.' }); } catch (e) { console.error('[kusto]', e); }
					break;
				}
				postMessageToHost({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });
			} catch (e: any) {
				try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'importConnectionsXmlError':
			try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (message && message.error ? String(message.error) : 'Unknown error') }); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'queryResult':
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Always target the concrete boxId when available (prevents races when
				// multiple queries are running and keeps comparison summaries in sync).
				if (message.boxId) {
					try {
						setQueryExecuting(message.boxId, false);
					} catch (e) { console.error('[kusto]', e); }
					displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
				} else {
					displayResult(message.result);
				}
			} catch (e: any) {
				console.error('Failed to render query results:', e);
			}
			try {
				if (message.boxId) {
					__kustoOnQueryResult(message.boxId, message.result);
				}
			} catch (e) { console.error('[kusto]', e); }
			// Check if this is a comparison box result
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId]) {
					const metadata = optimizationMetadataByBoxId[message.boxId];
					if (metadata.isComparison && metadata.sourceBoxId) {
						// Check if source box has results too
						const sourceState = getResultsState(metadata.sourceBoxId);
						const comparisonState = getResultsState(message.boxId);
						if (sourceState && comparisonState) {
							displayComparisonSummary(metadata.sourceBoxId, message.boxId);
						}
					}
				}
			} catch (err: any) {
				console.error('Error displaying comparison summary:', err);
			}
			// Also handle the inverse: source box result arrives after comparison
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId] && optimizationMetadataByBoxId[message.boxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[message.boxId].comparisonBoxId;
					const sourceState = getResultsState(message.boxId);
					const comparisonState = getResultsState(comparisonBoxId);
					if (sourceState && comparisonState) {
						displayComparisonSummary(message.boxId, comparisonBoxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'queryError':
			try {
				if (message && message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				const err = (message && 'error' in message) ? message.error : 'Query execution failed.';
				try {
					if (boxId) {
						setQueryExecuting(boxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				if (boxId) {
					const clientActivityId = (message && typeof message.clientActivityId === 'string') ? message.clientActivityId : undefined;
					__kustoRenderErrorUx(boxId, err, clientActivityId);
				} else {
					console.error('Query error (no error renderer available):', err);
				}
			} catch (e: any) {
				console.error('Failed to render query error:', e);
			}
			break;
		case 'queryCancelled':
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const cancelledBoxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				if (cancelledBoxId) {
					setQueryExecuting(cancelledBoxId, false);
				}
			} catch (e) { console.error('[kusto]', e); }
			displayCancelled();
			break;
		case 'ensureResultsVisible':
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : '';
				if (boxId) {
					__kustoSetResultsVisible(boxId, true);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonResult':
			try { onPythonResult(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonError':
			try { onPythonError(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'urlContent':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'urlError':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'schemaData':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			
			try {
				const cid = String(message.connectionId || '').trim();
				const db = String(message.database || '').trim();
				if (cid && db) {
					schemaByConnDb[cid + '|' + db] = message.schema;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.resolve === 'function') {
					try { r.resolve(message.schema); } catch (e) { console.error('[kusto]', e); }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Normal per-editor schema update (autocomplete).
			// This is the SINGLE source of truth for schema data - no duplicate caching
			schemaByBoxId[message.boxId] = message.schema;
			schemaFetchInFlightByBoxId[message.boxId] = false;
			
			// Update monaco-kusto with the raw schema JSON if available
			// With aggregate schema approach, we always push schemas to monaco-kusto
			// The __kustoSetMonacoKustoSchema function handles de-duplication and uses addDatabaseToSchema for subsequent loads
			try {
				const schemaKey = message.clusterUrl && message.database ? `${message.clusterUrl}|${message.database}` : null;
				
				// Check if this box is the active/focused box - if so, we should set it as the context
				const isActiveBox = message.boxId === activeQueryEditorBoxId;
				
				// Always push schema to monaco-kusto if we have rawSchemaJson
				// The __kustoSetMonacoKustoSchema function will:
				// - Skip if already loaded (unless setAsContext is true)
				// - Use setSchemaFromShowSchema for first schema
				// - Use addDatabaseToSchema for subsequent schemas (aggregate approach)
				// - If setAsContext is true, also switch the database in context
				const shouldUpdate = schemaKey && message.schema && message.schema.rawSchemaJson && message.clusterUrl && message.database;
				const isForceRefresh = !!(message.schemaMeta && message.schemaMeta.forceRefresh);
				
				if (shouldUpdate) {
					const applySchema = async () => {
						if (typeof window.__kustoSetMonacoKustoSchema === 'function') {
							// Schema/context state in monaco-kusto is tracked PER Monaco model URI.
							// If we don't pass the model URI, monaco.js falls back to models[0], which can
							// immediately put the wrong database in context for the active editor.
							let modelUri: any = null;
							try {
								const editor = queryEditors ? queryEditors[message.boxId] : null;
								const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
								if (model && model.uri) {
									modelUri = model.uri.toString();
								}
							} catch (e) { console.error('[kusto]', e); }

							// If we can't resolve a model URI yet (editor not ready), retry later.
							if (!modelUri) {
								return false;
							}

							// Set as context if this is the active box, OR if this is a force-refresh.
							// When the user clicks "Refresh schema" (forceRefresh), the editor may have lost
							// focus (activeQueryEditorBoxId cleared to null by onDidBlurEditorWidget).
							// Without setAsContext=true, addDatabaseToSchema updates the aggregate schema
							// but the stale in-context database persists, causing completions to stay stale.
							const shouldSetAsContext = isActiveBox || isForceRefresh;
							await window.__kustoSetMonacoKustoSchema(message.schema.rawSchemaJson, message.clusterUrl, message.database, shouldSetAsContext, modelUri, isForceRefresh);
							
							// Trigger revalidation to reflect the new schema
							if (shouldSetAsContext && typeof window.__kustoTriggerRevalidation === 'function') {
								window.__kustoTriggerRevalidation(message.boxId);
							}
							return true;
						}
						return false;
					};
					
					// Try immediately
					applySchema().then((success: any) => {
						if (!success) {
							// If function not available yet, retry after monaco-kusto loads
							const retryDelays = [100, 300, 600, 1000, 2000];
							let retryIndex = 0;
							const retry = () => {
								if (retryIndex < retryDelays.length) {
									setTimeout(() => {
										applySchema().then((applied: any) => {
											if (!applied) {
												retryIndex++;
												retry();
											}
										});
									}, retryDelays[retryIndex]);
								}
							};
							retry();
						}
					});
				}
			} catch (e: any) { console.error('[schemaData] Error:', e); }
			
			// NOTE: Custom diagnostics are disabled - monaco-kusto handles validation
			// try {
			// 	if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
			// 		window.__kustoScheduleKustoDiagnostics(message.boxId, 0);
			// 	}
			// } catch (e) { console.error('[kusto]', e); }
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const functionsCount = meta.functionsCount ?? (message.schema?.functions?.length ?? 0);
				const hasRawSchemaJson = !!(message.schema && message.schema.rawSchemaJson);
				const isFailoverToCache = !!meta.isFailoverToCache;
				
				// Determine display text and error state based on schema completeness
				let displayText = tablesCount + ' tables, ' + columnsCount + ' cols';
				let tooltipText = 'Schema loaded for autocomplete';
				let isError = false;
				
				if (meta.fromCache) {
					if (isFailoverToCache && !hasRawSchemaJson) {
						// Cached schema from failover but missing rawSchemaJson - autocomplete won't work
						displayText = 'Schema outdated';
						tooltipText = 'Cached schema is outdated. Autocomplete may not work. Try refreshing schema when connected.';
						isError = true;
					} else if (isFailoverToCache) {
						// Cached schema from failover with rawSchemaJson - works but stale
						displayText += ' (cached)';
						tooltipText = 'Using cached schema after connection failure. Schema may be outdated.';
						// Not an error since autocomplete still works
					} else {
						// Normal cache hit
						displayText += ' (cached)';
						tooltipText += ' (cached)';
					}
				}
				
				try {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo(displayText, isError,
							{ fromCache: !!meta.fromCache, tablesCount, columnsCount, functionsCount, hasRawSchemaJson, isFailoverToCache }));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'schemaError':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message.error || 'Schema fetch failed')); } catch (e) { console.error('[kusto]', e); }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }
			// Non-fatal; keep any previously loaded schema + counts if present.
			schemaFetchInFlightByBoxId[message.boxId] = false;
			try {
				const hasSchema = !!(schemaByBoxId && schemaByBoxId[message.boxId]);
				if (!hasSchema) {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				}
			} catch {
				try {
					const kwEl2 = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl2 && typeof kwEl2.setSchemaInfo === 'function') {
						kwEl2.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			try {
				__kustoDisplayBoxError(message.boxId, message.error || 'Schema fetch failed');
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'crossClusterSchemaData':
			// Handle cross-cluster schema response
			try {
				const clusterName = message.clusterName;
				const clusterUrl = message.clusterUrl;
				const database = message.database;
				const rawSchemaJson = message.rawSchemaJson;
				
				if (rawSchemaJson && typeof window.__kustoApplyCrossClusterSchema === 'function') {
					window.__kustoApplyCrossClusterSchema(clusterName, clusterUrl, database, rawSchemaJson);
				}
			} catch (e: any) {
				console.error('[crossClusterSchemaData] Error:', e);
			}
			break;
		case 'crossClusterSchemaError':
			// Handle cross-cluster schema error
			try {
				const clusterName = message.clusterName;
				const database = message.database;
				const key = `${clusterName.toLowerCase()}|${database.toLowerCase()}`;
				
				// Mark as error so we don't keep retrying
				__kustoCrossClusterSchemas[key] = { status: 'error', error: message.error };
			} catch (e) { console.error('[kusto]', e); }
			break;
			case 'connectionAdded':
				// Refresh list and preselect the new connection in the originating box.
				if (Array.isArray(message.connections)) {
					setConnections(message.connections);
					try { window.connections = connections; } catch (e) { console.error('[kusto]', e); }
				}
				if (message.lastConnectionId) {
					setLastConnectionId(message.lastConnectionId);
				}
				if (typeof message.lastDatabase === 'string') {
					setLastDatabase(message.lastDatabase);
				}
				updateConnectionSelects();
				try {
					__kustoOnConnectionsUpdated();
				} catch (e) { console.error('[kusto]', e); }
				try {
					const boxId = message.boxId || null;
					if (boxId && message.connectionId) {
						const kwEl = __kustoGetQuerySectionElement(boxId);
						if (kwEl && typeof kwEl.setConnectionId === 'function') {
							kwEl.setConnectionId(message.connectionId);
							kwEl.dispatchEvent(new CustomEvent('connection-changed', {
								detail: { boxId: boxId, connectionId: message.connectionId },
								bubbles: true, composed: true,
							}));
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				break;
		case 'copilotChatFirstTimeResult':
			try {
				// Update local flag so the dialog is never shown again.
				pState.copilotChatFirstTimeDismissed = true;
				const action = String(message.action || '');
				if (action === 'proceed') {
					// User chose to use the embedded copilot chat; toggle it open.
					const ftBoxId = String(message.boxId || '').trim();
					const kwEl = ftBoxId ? __kustoGetQuerySectionElement(ftBoxId) : null;
					if (kwEl && typeof kwEl.setCopilotChatVisible === 'function') {
						kwEl.setCopilotChatVisible(true);
					}
				}
				// 'openedAgent' and 'dismissed': do nothing in webview (agent was opened or dialog dismissed).
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotAvailability':
			try {
				const boxId = message.boxId || '';
				const available = !!message.available;
				// Per-editor toolbar toggle button
				try {
					const applyToButton = (btn: any) => {
						if (!btn) return;
						const inProgress = !!(btn.dataset && btn.dataset.kustoCopilotChatInProgress === '1');
						if (!available) {
							btn.disabled = true;
							try { if (btn.dataset) btn.dataset.kustoDisabledByCopilot = '1'; } catch (e) { console.error('[kusto]', e); }
							btn.title = 'Copilot chat\n\nGitHub Copilot is required for this feature. Enable Copilot in VS Code to use Copilot-assisted query writing.';
							btn.setAttribute('aria-disabled', 'true');
						} else {
							const disabledByCopilot = !!(btn.dataset && btn.dataset.kustoDisabledByCopilot === '1');
							if (disabledByCopilot) {
								try { if (btn.dataset) delete btn.dataset.kustoDisabledByCopilot; } catch (e) { console.error('[kusto]', e); }
								if (!inProgress) {
									btn.disabled = false;
									btn.setAttribute('aria-disabled', 'false');
								}
							}
							btn.title = 'Copilot chat\nGenerate and run a query with GitHub Copilot';
						}
					};

					if (boxId === '__kusto_global__') {
						const btns = document.querySelectorAll('.kusto-copilot-chat-toggle');
						for (const b of btns) {
							applyToButton(b);
						}
						// Also update all kw-query-toolbar Lit elements.
						try {
							document.querySelectorAll('kw-query-toolbar').forEach((toolbar: any) => {
								if (typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
							});
						} catch (e) { console.error('[kusto]', e); }
					} else {
						applyToButton(document.getElementById(boxId + '_copilot_chat_toggle'));
						// Also update the kw-query-toolbar Lit element.
						try {
							const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any;
							if (toolbar && typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					// The "Compare two queries" button does not require Copilot.
					try {
						if (optimizeBtn.dataset) {
							delete optimizeBtn.dataset.kustoDisabledByCopilot;
							delete optimizeBtn.dataset.kustoCopilotAvailable;
						}
					} catch (e) { console.error('[kusto]', e); }
					optimizeBtn.title = 'Compare two queries';
					optimizeBtn.setAttribute('aria-label', 'Compare two queries');
					// Do not forcibly enable if some other flow disabled it (e.g. query box is removed).
					// Only undo any Copilot-based disabling.
					try {
						if (optimizeBtn.disabled && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeInProgress !== '1') {
							optimizeBtn.disabled = false;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryStatus':
			try {
				const boxId = message.boxId || '';
				const status = message.status || '';
				try {
					__kustoSetOptimizeInProgress(boxId, true, status);
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'compareQueryPerformanceWithQuery':
			try {
				const boxId = String(message.boxId || '');
				const query = String(message.query || '');
				if (boxId) {
					Promise.resolve(optimizeQueryWithCopilot(boxId, query));
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryReady':
			try {
				const sourceBoxId = message.boxId || '';
				try {
					{
						__kustoSetOptimizeInProgress(sourceBoxId, false, '');
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoHideOptimizePromptForBox(sourceBoxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizedQuery = message.optimizedQuery || '';
				let queryName = message.queryName || '';
				// Ensure the source section has a name for optimization.
				// If missing, assign the next unused letter (A, B, C, ...).
				try {
					const nameEl = document.getElementById(sourceBoxId + '_name') as any;
					if (nameEl) {
						let sourceName = String(nameEl.value || '').trim();
						if (!sourceName && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
							sourceName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
							nameEl.value = sourceName;
							try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						}
						if (sourceName) {
							queryName = sourceName;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Fallback: if we still don't have a name (e.g. input missing), pick one.
				if (!String(queryName || '').trim() && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
					try {
						queryName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
					} catch (e) { console.error('[kusto]', e); }
				}
				const desiredOptimizedName = String(queryName || '').trim() ? (String(queryName || '').trim() + ' (optimized)') : '';
				const connectionId = message.connectionId || '';
				const database = message.database || '';
				let prettifiedOptimizedQuery = optimizedQuery;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						prettifiedOptimizedQuery = window.__kustoPrettifyKustoText(optimizedQuery);
					}
				} catch (e) { console.error('[kusto]', e); }
				
				// If a comparison box already exists for this source, reuse it.
				if (optimizationMetadataByBoxId[sourceBoxId] && optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId;
					const comparisonEditor = queryEditors && queryEditors[comparisonBoxId];
					if (comparisonBoxId && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
						try {
							comparisonEditor.setValue(prettifiedOptimizedQuery);
							try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						} catch (e) { console.error('[kusto]', e); }
						// Name the optimized section "<source name> (optimized)".
						try {
							const nameEl = document.getElementById(comparisonBoxId + '_name') as any;
							if (nameEl) {
								if (desiredOptimizedName) {
									nameEl.value = desiredOptimizedName;
									try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							optimizationMetadataByBoxId[comparisonBoxId] = optimizationMetadataByBoxId[comparisonBoxId] || {};
							optimizationMetadataByBoxId[comparisonBoxId].sourceBoxId = sourceBoxId;
							optimizationMetadataByBoxId[comparisonBoxId].isComparison = true;
							optimizationMetadataByBoxId[comparisonBoxId].originalQuery = queryEditors[sourceBoxId] ? queryEditors[sourceBoxId].getValue() : '';
							optimizationMetadataByBoxId[comparisonBoxId].optimizedQuery = prettifiedOptimizedQuery;
						} catch (e) { console.error('[kusto]', e); }
						try {
							{
								__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							{
								__kustoSetResultsVisible(sourceBoxId, false);
								__kustoSetResultsVisible(comparisonBoxId, false);
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							executeQuery(sourceBoxId);
							setTimeout(() => {
								try { executeQuery(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
							}, 100);
						} catch (e) { console.error('[kusto]', e); }
					}

					// Restore the optimize button state on source box
					const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn') as any;
					if (optimizeBtn) {
						optimizeBtn.disabled = false;
						if (optimizeBtn.dataset.originalContent) {
							optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
							delete optimizeBtn.dataset.originalContent;
						}
					}
					break;
				}
				
				// Create a new query box below the source box for comparison
				const comparisonBoxId = addQueryBox({ 
					id: 'query_opt_' + Date.now(), 
					initialQuery: prettifiedOptimizedQuery,
					isComparison: true,
					defaultResultsVisible: false
				});
				try {
					{
						__kustoSetResultsVisible(sourceBoxId, false);
						__kustoSetResultsVisible(comparisonBoxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
					}
				} catch (e) { console.error('[kusto]', e); }
				
				// Store optimization metadata
				optimizationMetadataByBoxId[comparisonBoxId] = {
					sourceBoxId: sourceBoxId,
					isComparison: true,
					originalQuery: queryEditors[sourceBoxId] ? queryEditors[sourceBoxId].getValue() : '',
					optimizedQuery: prettifiedOptimizedQuery
				};
				optimizationMetadataByBoxId[sourceBoxId] = {
					comparisonBoxId: comparisonBoxId
				};
				
				// Position the comparison box right after the source box
				try {
					const sourceBox = document.getElementById(sourceBoxId) as any;
					const comparisonBox = document.getElementById(comparisonBoxId) as any;
					if (sourceBox && comparisonBox && sourceBox.parentNode && comparisonBox.parentNode) {
						sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
					}
					// Scroll the new comparison box into view.
					if (comparisonBox && typeof comparisonBox.scrollIntoView === 'function') {
						comparisonBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
					}
				} catch (e) { console.error('[kusto]', e); }
				
				// Set connection and database to match source
				const compKwEl = __kustoGetQuerySectionElement(comparisonBoxId);
				if (compKwEl) {
					if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
					if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
					compKwEl.dispatchEvent(new CustomEvent('connection-changed', {
						detail: { boxId: comparisonBoxId, connectionId: connectionId },
						bubbles: true, composed: true,
					}));
					setTimeout(() => {
						if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
					}, 100);
				}
				
				// Set the query name
				if (desiredOptimizedName) {
					__kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
				}
				
				// Execute both queries for comparison
				executeQuery(sourceBoxId);
				setTimeout(() => {
					executeQuery(comparisonBoxId);
				}, 100);
				
				// Restore the optimize button state on source box
				const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (err: any) {
				console.error('Error creating comparison box:', err);
			}
			break;
		case 'optimizeQueryOptions':
			try {
				const boxId = message.boxId || '';
				const models = message.models || [];
				const selectedModelId = message.selectedModelId || '';
				const promptText = message.promptText || '';
				{
					__kustoApplyOptimizeQueryOptions(boxId, models, selectedModelId, promptText);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryError':
			try {
				const boxId = message.boxId || '';
				try {
					{
						__kustoSetOptimizeInProgress(boxId, false, '');
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoHideOptimizePromptForBox(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryOptions':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotApplyWriteQueryOptions === 'function') {
					kwEl.copilotApplyWriteQueryOptions(
						message.models || [],
						message.selectedModelId || '',
						message.tools || []
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryStatus':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryStatus === 'function') {
					kwEl.copilotWriteQueryStatus(message.status || '', message.detail || '', message.role || '');
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQuerySetQuery':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQuerySetQuery === 'function') {
					kwEl.copilotWriteQuerySetQuery(message.query || '');
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryExecuting':
			try {
				const boxId = String(message.boxId || '');
				const executing = !!message.executing;
				if (boxId) {
					setQueryExecuting(boxId, executing);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryToolResult':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryToolResult === 'function') {
					kwEl.copilotWriteQueryToolResult(
						message.tool || '',
						message.label || '',
						message.json || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotExecutedQuery':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendExecutedQuery === 'function') {
					kwEl.copilotAppendExecutedQuery(
						message.query || '',
						message.resultSummary || '',
						message.errorMessage || '',
						message.entryId || '',
						message.result || null
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotGeneralQueryRulesLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendGeneralRulesLink === 'function') {
					kwEl.copilotAppendGeneralRulesLink(
						message.filePath || '',
						message.preview || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotUserQuerySnapshot':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendQuerySnapshot === 'function') {
					kwEl.copilotAppendQuerySnapshot(
						message.queryText || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNotesContextLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNotesContext === 'function') {
					kwEl.copilotAppendDevNotesContext(
						message.preview || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNoteToolCall':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNoteToolCall === 'function') {
					const detail = message.action === 'save'
						? ('[' + (message.category || 'note') + '] ' + (message.content || ''))
						: ('Removed note: ' + (message.noteId || '') + (message.reason ? ' — ' + message.reason : ''));
					kwEl.copilotAppendDevNoteToolCall(
						message.action || 'save',
						detail,
						message.result || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotClarifyingQuestion':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendClarifyingQuestion === 'function') {
					kwEl.copilotAppendClarifyingQuestion(
						message.question || '',
						message.entryId || ''
					);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryDone':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
					kwEl.copilotWriteQueryDone(!!message.ok, message.message || '');
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotInlineCompletionResult':
			try {
				const requestId = String(message.requestId || '');
				const completions = message.completions || [];
				// Delegate to the handler registered by the inline completions provider.
				// This caches the result and re-triggers the inline suggest action.
				if (typeof _win.__kustoHandleInlineCompletionResult === 'function') {
					_win.__kustoHandleInlineCompletionResult(requestId, completions);
				}
			} catch (err: any) { console.error('[Kusto] Error handling completion result', err); }
			break;
		
		// ─────────────────────────────────────────────────────────────────────────
		// VS Code Copilot Chat Tool Orchestrator Messages
		// ─────────────────────────────────────────────────────────────────────────
		
		case 'requestToolState':
			// Extension is requesting the current sections state
			try {
				const requestId = String(message.requestId || '');
				if (requestId) {
					const state = getKqlxState();
					const sections = (state && state.sections) ? state.sections : [];
					postMessageToHost({ type: 'toolStateResponse', requestId, sections });
				}
			} catch (err: any) {
				console.error('[Kusto Tools] Error getting state:', err);
				try {
					postMessageToHost({ type: 'toolStateResponse', requestId: message.requestId, sections: [] });
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		
		case 'toolAddSection':
			// Add a new section via tool orchestrator
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionType = String(input.type || '').toLowerCase();
				let sectionId = '';
				let success = false;
				
				try {
					if (sectionType === 'query') {
						const queryOpts: any = {};
						if (input.query) {
							queryOpts.initialQuery = String(input.query);
						}
						sectionId = addQueryBox(queryOpts);
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
						if (sectionId && input.clusterUrl) {
							// Find connection by cluster URL
							const conn = (connections || []).find((c: any) => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
							if (conn) {
								const kwEl = __kustoGetQuerySectionElement(sectionId);
								if (kwEl && typeof kwEl.setConnectionId === 'function') {
									kwEl.setConnectionId(conn.id);
									kwEl.dispatchEvent(new CustomEvent('connection-changed', {
										detail: { boxId: sectionId, connectionId: conn.id, clusterUrl: conn.clusterUrl },
										bubbles: true, composed: true,
									}));
								}
							}
						}
						if (sectionId && input.database) {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.setDatabase === 'function') {
								kwEl.setDatabase(input.database);
								kwEl.dispatchEvent(new CustomEvent('database-changed', {
									detail: { boxId: sectionId, database: input.database },
									bubbles: true, composed: true,
								}));
							}
						}
					} else if (sectionType === 'markdown') {
						// Pass text as option so it's available when the editor initializes
						// Accept both 'text' and 'content' - LLMs may use either property name
						const textValue = input.text ?? input.content;
						const markdownOptions = (textValue !== undefined) ? { text: String(textValue) } : undefined;
						sectionId = addMarkdownBox(markdownOptions);
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'chart') {
						sectionId = addChartBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'transformation') {
						sectionId = addTransformationBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'url') {
						sectionId = addUrlBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'python') {
						sectionId = addPythonBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error adding section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { sectionId, success }, error: success ? undefined : 'Failed to add section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				console.error('[Kusto Tools] Error in toolAddSection:', err);
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolRemoveSection':
			// Remove a section by ID
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				
				try {
					const sectionEl = document.getElementById(sectionId) as any;
					if (sectionEl && typeof sectionEl.remove === 'function') {
						sectionEl.remove();
						success = true;
						// Clean up any associated state
						if (queryEditors && queryEditors[sectionId]) {
							delete queryEditors[sectionId];
						}
						if (schemaByBoxId && schemaByBoxId[sectionId]) {
							delete schemaByBoxId[sectionId];
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error removing section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Section not found' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolCollapseSection':
			// Collapse or expand a section
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				const collapsed = !!message.collapsed;
				let success = false;
				
				try {
					if (typeof window.__kustoSetSectionExpanded === 'function') {
						window.__kustoSetSectionExpanded(sectionId, !collapsed);
						success = true;
					} else {
						// Fallback: toggle visibility directly
						const contentEl = document.getElementById(sectionId + '_content') as any;
						if (contentEl) {
							contentEl.style.display = collapsed ? 'none' : '';
							success = true;
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error collapsing section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to collapse/expand section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolReorderSections':
			// Reorder all sections in the notebook
			try {
				const requestId = String(message.requestId || '');
				const sectionIds = Array.isArray(message.sectionIds) ? message.sectionIds.map((id: any) => String(id)) : [];
				let success = false;
				let error = '';
				
				try {
					const container = document.getElementById('queries-container');
					if (!container) {
						error = 'Container not found';
					} else {
						// Get current section elements
						const currentBoxes = Array.from(container.querySelectorAll('.query-box'));
						const currentIds = currentBoxes.map((el: any) => el.id).filter((id: any) => id);
						
						// Validate: all current IDs must be in the new order
						const missingIds = currentIds.filter((id: any) => !sectionIds.includes(id));
						const unknownIds = sectionIds.filter((id: any) => !currentIds.includes(id));
						
						if (missingIds.length > 0) {
							error = 'Missing section IDs in reorder list: ' + missingIds.join(', ');
						} else if (unknownIds.length > 0) {
							error = 'Unknown section IDs: ' + unknownIds.join(', ');
						} else {
							// Reorder: move sections to match the new order
							for (const sectionId of sectionIds) {
								const el = document.getElementById(sectionId) as any;
								if (el && el.parentNode === container) {
									container.appendChild(el);
								}
							}
							success = true;
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error reordering sections:', err);
					error = err.message || String(err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, error: error || undefined }, error: success ? undefined : (error || 'Failed to reorder sections') });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureQuerySection':
			// Configure a query section's connection, database, and optionally update query text
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				let resultPreview = '';
				
				try {
					const editor = queryEditors && queryEditors[sectionId];
					
					// Update section name if provided
					if (input.name !== undefined) {
						const nameInput = document.getElementById(sectionId + '_name') as any;
						if (nameInput) {
							nameInput.value = String(input.name);
							try { nameInput.dispatchEvent(new Event('input')); } catch (e) { console.error('[kusto]', e); }
							success = true;
						}
					}
					
					// Update query text
					if (input.query !== undefined && editor && typeof editor.setValue === 'function') {
						editor.setValue(String(input.query));
						success = true;
					}
					
					// Update cluster
					if (input.clusterUrl) {
						const conn = (connections || []).find((c: any) => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
						if (conn) {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.setConnectionId === 'function') {
								kwEl.setConnectionId(conn.id);
								kwEl.dispatchEvent(new CustomEvent('connection-changed', {
									detail: { boxId: sectionId, connectionId: conn.id, clusterUrl: conn.clusterUrl },
									bubbles: true, composed: true,
								}));
								success = true;
							}
						} else {
							// Connection not found - return error with available connections
							const availableConnections = (connections || []).map((c: any) => c && c.clusterUrl ? String(c.clusterUrl) : '').filter(Boolean);
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { 
									success: false, 
									error: `Cluster "${input.clusterUrl}" not found in configured connections.`,
									availableConnections,
									fix: 'Use #listKustoConnections to see available clusters.'
								}
							});
							return;
						}
					}
					
					// Update database (wait a bit for database list to populate after connection change)
					if (input.database) {
						if (input.clusterUrl) {
							await new Promise((r: any) => setTimeout(r, 500));
						}
						const kwEl = __kustoGetQuerySectionElement(sectionId);
						if (kwEl && typeof kwEl.setDatabase === 'function') {
							kwEl.setDatabase(input.database);
							kwEl.dispatchEvent(new CustomEvent('database-changed', {
								detail: { boxId: sectionId, database: input.database },
								bubbles: true, composed: true,
							}));
							success = true;
						}
					}
					
					// Execute if requested
					if (input.execute) {
						executeQuery(sectionId);
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring query section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, resultPreview }, error: success ? undefined : 'Failed to configure query section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolExecuteQuery':
			// Execute a query and return results preview
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				
				// Set up a one-time listener for the result
				const resultHandler = (resultEvent: any) => {
					try {
						const resultMsg = resultEvent && resultEvent.data;
						if (resultMsg && resultMsg.type === 'queryResult' && resultMsg.boxId === sectionId) {
							window.removeEventListener('message', resultHandler);
							
							const result = resultMsg.result || {};
							const rows = result.rows || [];
							const columns = result.columns || [];
							const rowCount = rows.length;
							
							// Create a preview (first 5 rows)
							let preview = '';
							try {
								const previewRows = rows.slice(0, 5);
								preview = JSON.stringify({ columns, rows: previewRows, totalRows: rowCount }, null, 2);
							} catch (e) { console.error('[kusto]', e); }
							
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: true, rowCount, columns, resultPreview: preview }
							});
						} else if (resultMsg && resultMsg.type === 'queryError' && resultMsg.boxId === sectionId) {
							window.removeEventListener('message', resultHandler);
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: false, error: resultMsg.error || 'Query execution failed' }
							});
						}
					} catch (e) { console.error('[kusto]', e); }
				};
				
				window.addEventListener('message', resultHandler);
				
				// Set timeout to clean up listener
				setTimeout(() => {
					window.removeEventListener('message', resultHandler);
				}, 120000); // 2 minute timeout
				
				executeQuery(sectionId);
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolUpdateMarkdownSection':
			// Update a markdown section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						const nameInput = document.getElementById(sectionId + '_name') as any;
						if (nameInput) {
							nameInput.value = String(input.name);
							try { nameInput.dispatchEvent(new Event('input')); } catch (e) { console.error('[kusto]', e); }
							success = true;
						}
					}
					
					// Accept both 'text' and 'content' - LLMs may use either property name
					const textValue = input.text ?? input.content;
					if (textValue !== undefined) {
						const textToSet = String(textValue);
						pState.pendingMarkdownTextByBoxId = pState.pendingMarkdownTextByBoxId || {};
						pState.pendingMarkdownTextByBoxId[sectionId] = textToSet;
						
						// Try to update existing editor (exposed on window from extraBoxes.js)
						const editorInstance = window.__kustoMarkdownEditors && window.__kustoMarkdownEditors[sectionId];
						if (editorInstance && typeof editorInstance.setValue === 'function') {
							editorInstance.setValue(textToSet);
							success = true;
							
							// Fit to contents after updating - with retries to handle async layout
							const fitToContents = () => {
								try {
									__kustoMaximizeMarkdownBox(sectionId);
								} catch (e) { console.error('[kusto]', e); }
							};
							// Apply immediately and with delays to handle async editor layout
							fitToContents();
							setTimeout(fitToContents, 100);
							setTimeout(fitToContents, 300);
							// If currently in Preview mode, re-render the viewer immediately
							try {
								if (typeof window.__kustoApplyMarkdownEditorMode === 'function') {
									window.__kustoApplyMarkdownEditorMode(sectionId);
								}
							} catch (e) { console.error('[kusto]', e); }
						} else {
							// Editor not initialized yet - text will be applied when editor initializes
							// from __kustoPendingMarkdownTextByBoxId
							success = true;
						}
					}
					
					if (input.mode && typeof window.__kustoSetMarkdownMode === 'function') {
						window.__kustoSetMarkdownMode(sectionId, input.mode);
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error updating markdown section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to update markdown section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureChart':
			// Configure a chart section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				let validationStatus: any = null;
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						const nameInput = document.getElementById(sectionId + '_name') as any;
						if (nameInput) {
							nameInput.value = String(input.name);
							try { nameInput.dispatchEvent(new Event('input')); } catch (e) { console.error('[kusto]', e); }
							success = true;
						}
					}
					
					// Apply chart configuration
					if (typeof window.__kustoConfigureChart === 'function') {
						window.__kustoConfigureChart(sectionId, input);
						success = true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingChartConfig = window.__kustoPendingChartConfig || {};
						window.__kustoPendingChartConfig[sectionId] = input;
						success = true;
					}
					
					// Get validation status to help agent verify configuration
					validationStatus = __kustoGetChartValidationStatus(sectionId);
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring chart:', err);
				}
				
				// Include validation status in response so agent can verify configuration worked
				const result = { success, ...( validationStatus ? { validation: validationStatus } : {}) };
				postMessageToHost({ type: 'toolResponse', requestId, result, error: success ? undefined : 'Failed to configure chart' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureTransformation':
			// Configure a transformation section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						const nameInput = document.getElementById(sectionId + '_name') as any;
						if (nameInput) {
							nameInput.value = String(input.name);
							try { nameInput.dispatchEvent(new Event('input')); } catch (e) { console.error('[kusto]', e); }
							success = true;
						}
					}
					
					// Apply transformation configuration
					if (typeof window.__kustoConfigureTransformation === 'function') {
						window.__kustoConfigureTransformation(sectionId, input);
						success = true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingTransformationConfig = window.__kustoPendingTransformationConfig || {};
						window.__kustoPendingTransformationConfig[sectionId] = input;
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring transformation:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to configure transformation' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolDelegateToKustoWorkbenchCopilot':
			// Delegate a question to the internal Copilot Chat by simulating user interaction:
			// 1. Toggle copilot button to show chat
			// 2. Paste question into chat input
			// 3. Click send button
			// 4. Wait for results to be displayed before returning
			(async () => {
				try {
					const requestId = String(message.requestId || '');
					const input = message.input || {};
					const question = String(input.question || '');
					let sectionId = String(input.sectionId || '');
					
					// If no section specified, use the first query section or create one
					if (!sectionId) {
						const sections = document.querySelectorAll('[data-section-type="query"]');
						if (sections.length > 0) {
							sectionId = sections[0].id;
						} else {
							sectionId = addQueryBox();
						}
					}
					
					if (!sectionId) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No query section available' } });
						return;
					}
					
					// VALIDATE: Check that connection and database are configured on this section
					const currentConnectionId = __kustoGetConnectionId(sectionId) || '';
					const currentDatabase = __kustoGetDatabase(sectionId) || '';
					
					// Get cluster URL for context
					let currentClusterUrl = '';
					try {
						if (currentConnectionId && Array.isArray(connections)) {
							const conn = connections.find((c: any) => c && String(c.id || '') === currentConnectionId);
							currentClusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					
					if (!currentConnectionId) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: 'Query section has no cluster connection configured.',
								sectionId,
								fix: 'Use #configureKustoQuerySection to set up the connection first. Call #listKustoFavorites to find available cluster/database pairs.'
							}
						});
						return;
					}
					
					if (!currentDatabase) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: `Query section is connected to cluster${currentClusterUrl ? ` (${currentClusterUrl})` : ''} but no database is selected.`,
								sectionId,
								clusterUrl: currentClusterUrl || undefined,
								fix: 'Use #configureKustoQuerySection to set the database. You can use #getKustoSchema with the clusterUrl to see available databases.'
							}
						});
						return;
					}
				
				// Ensure the section is in 'Run Query' mode (plain) — not 'take 100' or 'sample 100'.
				// This prevents the Copilot-generated queries from having unwanted limits appended.
				try {
					setRunMode(sectionId, 'plain');
				} catch (e) { console.error('[kusto]', e); }

				// Step 1: Show the Copilot Chat panel (toggle the button)
				{
					const kwEl = __kustoGetQuerySectionElement(sectionId);
					if (kwEl && typeof kwEl.setCopilotChatVisible === 'function') {
						kwEl.setCopilotChatVisible(true);
					}
				}
				
				// Give the UI a moment to render
				await new Promise((r: any) => setTimeout(r, 100));
				
				// Step 2: Paste the question into the chat input
				const chatInput = document.getElementById(sectionId + '_copilot_input') as any;
				if (!chatInput) {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Copilot chat input not found. Is Copilot available?' } });
					return;
				}
				chatInput.value = question;
				chatInput.dispatchEvent(new Event('input', { bubbles: true }));
				
				// Set up listener for results BEFORE clicking send
				let responded = false;
				let generatedQuery = '';
				let queryGenerated = false;
				let pendingQueryResult: any = null; // Store queryResult if it arrives before copilotWriteQueryDone
				
				// Helper to send successful response
				const sendSuccessResponse = (msg: any) => {
					if (responded) return;
					responded = true;
					window.removeEventListener('message', resultHandler);
					
					// Get current query from editor
					try {
						const editor = queryEditors && queryEditors[sectionId];
						if (editor && typeof editor.getValue === 'function') {
							generatedQuery = editor.getValue() || generatedQuery;
						}
					} catch (e) { console.error('[kusto]', e); }
					
					// Don't call __kustoCopilotWriteQueryDone here — the regular
					// 'copilotWriteQueryDone' handler already does it.
					
					// Get the results
					let rows: any[] = [];
					let columns: any[] = [];
					let rowCount = 0;
					
					// Try to get from the result state (most reliable after display)
					try {
						const resultState = getResultsState(sectionId);
						if (resultState) {
							columns = Array.isArray(resultState.columns) ? resultState.columns : [];
							rows = Array.isArray(resultState.rows) ? resultState.rows : [];
							rowCount = rows.length;
						}
					} catch (e) { console.error('[kusto]', e); }
					
					// Fallback to message data
					if (columns.length === 0 && msg && msg.result && msg.result.primaryResults && msg.result.primaryResults.length > 0) {
						const primary = msg.result.primaryResults[0];
						columns = primary.columns ? primary.columns.map((c: any) => c.name || c) : [];
						rows = primary.rows || [];
						rowCount = rows.length;
					}
					
					// Limit rows for response size
					const truncated = rows.length > 100;
					if (truncated) {
						rows = rows.slice(0, 100);
					}
					
					postMessageToHost({ 
						type: 'toolResponse', 
						requestId, 
						result: { 
							success: true,
							query: generatedQuery,
							rowCount,
							columns,
							results: rows,
							truncated: truncated ? 'Results truncated to 100 rows' : undefined
						}
					});
				};
				
				const resultHandler = (event: any) => {
					try {
						const msg = event && event.data;
						if (!msg || responded) return;
						
						// Copilot finished generating/writing query
						if (msg.type === 'copilotWriteQueryDone' && msg.boxId === sectionId) {
							queryGenerated = true;
							try {
								const editor = queryEditors && queryEditors[sectionId];
								generatedQuery = editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
							} catch (e) { console.error('[kusto]', e); }
							
							if (!msg.ok) {
								responded = true;
								window.removeEventListener('message', resultHandler);
								
								// Don't call __kustoCopilotWriteQueryDone here — the regular
								// 'copilotWriteQueryDone' handler already does it, and calling
								// it again produces a duplicate "Canceled." notification.
								
								postMessageToHost({ 
									type: 'toolResponse', 
									requestId, 
									result: { 
										success: false,
										error: msg.message || 'Copilot failed to generate query',
										query: generatedQuery || undefined
									}
								});
								return;
							}
							
							// If we already received queryResult, process it now
							if (pendingQueryResult) {
								sendSuccessResponse(pendingQueryResult);
								return;
							}
							// Otherwise wait for queryResult
						}
						
						// Query results arrived
						if (msg.type === 'queryResult' && msg.boxId === sectionId) {
							if (queryGenerated) {
								// copilotWriteQueryDone already arrived with ok=true, send response now
								sendSuccessResponse(msg);
							} else {
								// copilotWriteQueryDone hasn't arrived yet, store for later
								pendingQueryResult = msg;
							}
						}
						
						// Query execution error
						if (msg.type === 'queryError' && msg.boxId === sectionId && queryGenerated) {
							responded = true;
							window.removeEventListener('message', resultHandler);
							
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { 
									success: false,
									query: generatedQuery || undefined,
									error: msg.error || 'Query execution failed'
								}
							});
						}
					} catch (err: any) {
						console.error('[Kusto Tools] Error in result handler:', err);
					}
				};
				
				window.addEventListener('message', resultHandler);
				
				// Timeout after 3 minutes
				const timeoutId = setTimeout(() => {
					if (!responded) {
						responded = true;
						window.removeEventListener('message', resultHandler);
						
						// Clear the Copilot chat "thinking..." state on timeout
						// (unlike cancel/error, no regular handler will clear this)
						try {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
								kwEl.copilotWriteQueryDone(false, 'Request timed out');
							}
						} catch (e) { console.error('[kusto]', e); }
						
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false,
								timedOut: true,
								query: generatedQuery || undefined,
								error: 'Request timed out after 3 minutes'
							}
						});
					}
				}, 180000);
				
				// Step 3: Click the send button (simulating user clicking Send)
				const sendButton = document.getElementById(sectionId + '_copilot_send') as any;
				if (sendButton && !sendButton.disabled) {
					sendButton.click();
				} else {
					// Fallback: call the send function via kw-query-section
					const kwEl2 = __kustoGetQuerySectionElement(sectionId);
					if (kwEl2 && typeof kwEl2.copilotWriteQuerySend === 'function') {
						kwEl2.copilotWriteQuerySend();
					} else {
						// Clean up and report error
						clearTimeout(timeoutId);
						window.removeEventListener('message', resultHandler);
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Could not find send button or send function' } });
					}
				}
				
				} catch (err: any) {
					console.error('[Kusto Tools] Error delegating to Copilot:', err);
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
		
		case 'shareContentReady':
			// Write rich HTML + plain text to the clipboard for Teams / rich-text paste.
			try {
				const html = String(message.html || '');
				const text = String(message.text || '');
				if (navigator.clipboard && typeof navigator.clipboard.write === 'function') {
					const htmlBlob = new Blob([html], { type: 'text/html' });
					const textBlob = new Blob([text], { type: 'text/plain' });
					navigator.clipboard.write([
						new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
					]).catch(() => {
						// Fallback to plain text if HTML clipboard write fails.
						try { navigator.clipboard.writeText(text); } catch (e) { console.error('[kusto]', e); }
					});
				} else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(text);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'resetCopilotModelSelection':
			// Clear the cached model selection from webview state and localStorage
			try {
				// Clear from vscode state
				const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
				delete state.lastOptimizeModelId;
				if (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.setState) {
					_win.vscode.setState(state);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Clear from localStorage
				localStorage.removeItem('kusto.optimize.lastModelId');
			} catch (e) { console.error('[kusto]', e); }
			break;
	}
});

// Request connections on load (only in the query editor webview, not side-panel webviews
// like cached-values or connection-manager that also load the bundle).
if (window.vscode) {
	postMessageToHost({ type: 'getConnections' });
	// Global Copilot capability check (for add-controls Copilot button)
	try { postMessageToHost({ type: 'checkCopilotAvailability', boxId: '__kusto_global__' }); } catch (e) { console.error('[kusto]', e); }
	// Request document state on load (.kqlx custom editor)
	try { postMessageToHost({ type: 'requestDocument' }); } catch (e) { console.error('[kusto]', e); }
}

// Initial content is now driven by the .kqlx document state.

// Drag-and-drop reorder for sections in .kqlx.
// Reorders DOM children of #queries-container, then persistence saves the new order.
(function __kustoInstallSectionReorder() {
	const tryInstall = () => {
		const container = document.getElementById('queries-container');
		if (!container) {
			setTimeout(tryInstall, 50);
			return;
		}
		try {
			if (container.dataset && container.dataset.kustoSectionReorder === 'true') {
				return;
			}
			if (container.dataset) {
				container.dataset.kustoSectionReorder = 'true';
			}
		} catch (e) { console.error('[kusto]', e); }

		let draggingId = '';
		let draggingOriginalNextSibling: any = null;
		let draggingDidDrop = false;
		let globalDnDGuardsInstalled = false;

		// While reordering, prevent the browser (and editors like Monaco) from treating this as a text drop.
		// Without this, dropping over an input/textarea/editor surface can insert the drag payload and create
		// a real edit, which then correctly leaves the document dirty.
		const ensureGlobalDnDGuards = () => {
			if (globalDnDGuardsInstalled) return;
			globalDnDGuardsInstalled = true;
			try {
					const isInContainer = (eventTarget: any) => {
						try {
							return !!(container && eventTarget && container.contains && container.contains(eventTarget));
						} catch {
							return false;
						}
					};
					document.addEventListener('dragenter', (e: any) => {
						if (!draggingId) return;
						try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						// Only suppress drag events outside the container, so live reordering still works.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
					}, true);
				document.addEventListener('dragover', (e: any) => {
					if (!draggingId) return;
					try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						// Allow container dragover to run so we can live-reorder.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
				}, true);
				document.addEventListener('drop', (e: any) => {
					if (!draggingId) return;
						// If the drop is inside the container, let the container's drop handler finish the reorder.
						if (isInContainer(e.target)) return;
						try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
				}, true);
			} catch (e) { console.error('[kusto]', e); }
		};

		const resyncArraysFromDom = () => {
			try {
				const ids = Array.from(container.children || [])
					.map((el: any) => (el && el.id ? String(el.id) : ''))
					.filter(Boolean);
				try { setQueryBoxes(ids.filter((id: any) => id.startsWith('query_'))); } catch (e) { console.error('[kusto]', e); }
				try { const mdIds = ids.filter((id: any) => id.startsWith('markdown_')); markdownBoxes.length = 0; markdownBoxes.push(...mdIds); } catch (e) { console.error('[kusto]', e); }
				try { const pyIds = ids.filter((id: any) => id.startsWith('python_')); pythonBoxes.length = 0; pythonBoxes.push(...pyIds); } catch (e) { console.error('[kusto]', e); }
				try { const urlIds = ids.filter((id: any) => id.startsWith('url_')); urlBoxes.length = 0; urlBoxes.push(...urlIds); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		const bestEffortRelayoutMovedEditors = (boxId: any) => {
			try {
				const q = queryEditors ? queryEditors[boxId] : null;
				const md = markdownEditors ? markdownEditors[boxId] : null;
				const py = (typeof window.__kustoPythonEditors !== 'undefined' && window.__kustoPythonEditors) ? window.__kustoPythonEditors[boxId] : null;
				const editors = [q, md, py].filter(Boolean);
				if (!editors.length) return;
				setTimeout(() => {
					for (const ed of editors) {
						try { if (ed && typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
					}
				}, 0);
			} catch (e) { console.error('[kusto]', e); }
		};

		// ── Reorder Popup: intercept drag-handle mousedown to open the minimap popup ──
		// A mousedown + small mousemove on any .section-drag-handle triggers the popup
		// instead of the native HTML5 drag. Works across shadow DOM boundaries.
		(function installReorderPopupTrigger() {
			let pending = false;
			let startX = 0;
			let startY = 0;
			let targetSectionId = '';
			const MOVE_THRESHOLD = 3; // px — avoid opening on accidental clicks

			const findSectionFromHandle = (handle: HTMLElement): HTMLElement | null => {
				// Walk from the handle's shadow host up to find a direct child of container.
				// Supports nested shadow DOM (e.g. handle inside kw-section-shell inside kw-python-section).
				try {
					let el: any = (handle.getRootNode?.() as any)?.host;
					while (el) {
						if (el.parentElement === container && el.id) return el;
						if (el.parentElement) {
							el = el.parentElement;
						} else {
							// Cross shadow boundary: parentElement is null when inside
							// another shadow root — walk to the outer host.
							el = (el.getRootNode?.() as any)?.host ?? null;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				return null;
			};

			const onMouseMove = (e: MouseEvent) => {
				if (!pending) return;
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				if (Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
				// Threshold met — open the popup
				cleanup();
				try {
					const popup = document.getElementById('sectionReorderPopup') as any;
					if (popup && typeof popup.open === 'function' && !popup.isOpen) {
						popup.open(targetSectionId);
					}
				} catch (e) { console.error('[kusto]', e); }
			};

			const onMouseUp = () => {
				cleanup();
			};

			const cleanup = () => {
				pending = false;
				targetSectionId = '';
				document.removeEventListener('mousemove', onMouseMove, true);
				document.removeEventListener('mouseup', onMouseUp, true);
			};

			document.addEventListener('mousedown', (e: MouseEvent) => {
				if (pending) return;
				// Check compatibility mode
				try { if (pState.compatibilityMode) return; } catch (e) { console.error('[kusto]', e); }
				// Find handle across shadow DOM
				const path = e.composedPath?.() ?? [];
				let handle: HTMLElement | null = null;
				for (const el of path) {
					if ((el as HTMLElement).classList?.contains('section-drag-handle')) {
						handle = el as HTMLElement;
						break;
					}
				}
				if (!handle) return;
				const section = findSectionFromHandle(handle);
				if (!section) return;
				pending = true;
				startX = e.clientX;
				startY = e.clientY;
				targetSectionId = section.id;
				document.addEventListener('mousemove', onMouseMove, true);
				document.addEventListener('mouseup', onMouseUp, true);
			}, true);
		})();

		container.addEventListener('dragstart', (e: any) => {
			ensureGlobalDnDGuards();
			try {
				// Only allow reordering in .kqlx mode.
				if (pState.compatibilityMode) {
					try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
					try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
					return;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Check composedPath() first for shadow DOM drag handles, then fallback to e.target.closest.
			let handle: any = null;
			try {
				const path = e.composedPath ? e.composedPath() : [];
				for (const el of path) {
					if (el && el.classList && el.classList.contains('section-drag-handle')) {
						handle = el;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			if (!handle) {
				handle = e && e.target && e.target.closest ? e.target.closest('.section-drag-handle') : null;
			}
			if (!handle) {
				return;
			}

			// Find the section host: walk composedPath for any direct child of the container.
			let box: any = null;
			try {
				const path = e.composedPath ? e.composedPath() : [];
				for (const el of path) {
					if (el && el.parentElement === container && el.id) {
						box = el;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			// Fallback: walk from the handle's host element
			if (!box) {
				try {
					let el = handle.getRootNode?.()?.host;
					while (el) {
						if (el.parentElement === container && el.id) {
							box = el;
							break;
						}
						if (el.parentElement) {
							el = el.parentElement;
						} else {
							el = (el.getRootNode?.() as any)?.host ?? null;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			if (!box || !box.id) {
				return;
			}

			// Open the reorder popup instead of doing an inline drag.
			try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
			try {
				const popup = document.getElementById('sectionReorderPopup') as any;
				if (popup && typeof popup.open === 'function') {
					if (!popup.isOpen) {
						popup.open(String(box.id));
					}
					return;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Fallback to legacy inline drag if popup is unavailable.
			draggingId = String(box.id);
			draggingDidDrop = false;
			try {
				// Remember original position so we can revert if the drag is cancelled.
				draggingOriginalNextSibling = box.nextElementSibling || null;
			} catch {
				draggingOriginalNextSibling = null;
			}
			try {
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
					// Keep the text payload empty so dropping over an editor/input can't insert meaningful text.
					try { e.dataTransfer.setData('text/plain', ''); } catch (e) { console.error('[kusto]', e); }
					try { e.dataTransfer.setData('application/x-kusto-section-reorder', draggingId); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		container.addEventListener('dragover', (e: any) => {
			if (!draggingId) {
				return;
			}
			try {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
			} catch (e) { console.error('[kusto]', e); }

			// Live reorder as the mouse moves.
			try {
				const dragged = document.getElementById(draggingId) as any;
				if (!dragged) return;
				const y = typeof e.clientY === 'number' ? e.clientY : null;
				if (y === null) return;
				const boxes = Array.from(container.children || [])
					.filter((el: any) => el && el.classList && el.classList.contains('query-box') && el !== dragged);
				if (boxes.length === 0) return;

				let insertBeforeEl: any = null;
				for (const box of boxes as any[]) {
					let rect;
					try { rect = box.getBoundingClientRect(); } catch { rect = null; }
					if (!rect) continue;
					const midY = rect.top + (rect.height / 2);
					if (y < midY) {
						insertBeforeEl = box;
						break;
					}
				}
				if (insertBeforeEl) {
					if (dragged.nextElementSibling !== insertBeforeEl) {
						container.insertBefore(dragged, insertBeforeEl);
					}
				} else {
					if (container.lastElementChild !== dragged) {
						container.appendChild(dragged);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		container.addEventListener('drop', (e: any) => {
			if (!draggingId) {
				return;
			}
			try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
			draggingDidDrop = true;
			const dragged = document.getElementById(draggingId) as any;
			if (!dragged) {
				draggingId = '';
				return;
			}

			// Compute insertion point based on the drop Y position.
			// This is much more reliable when dropping in whitespace above the first or below the last section.
			try {
				const dropY = typeof e.clientY === 'number' ? e.clientY : null;
				const boxes = Array.from(container.children || [])
					.filter((el: any) => el && el.classList && el.classList.contains('query-box') && el !== dragged);

				if (boxes.length === 0) {
					container.appendChild(dragged);
				} else if (dropY === null) {
					container.appendChild(dragged);
				} else {
					let inserted = false;
					for (const box of boxes as any[]) {
						let rect;
						try { rect = box.getBoundingClientRect(); } catch { rect = null; }
						if (!rect) continue;
						const midY = rect.top + (rect.height / 2);
						if (dropY < midY) {
							container.insertBefore(dragged, box);
							inserted = true;
							break;
						}
					}
					if (!inserted) {
						container.appendChild(dragged);
					}
				}
			} catch {
				try { container.appendChild(dragged); } catch (e) { console.error('[kusto]', e); }
			}

			resyncArraysFromDom();
			bestEffortRelayoutMovedEditors(draggingId);
			try { schedulePersist && schedulePersist('reorder'); } catch (e) { console.error('[kusto]', e); }
			// Refresh Data dropdowns in Chart/Transformation sections to update position labels
			try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
			draggingId = '';
			draggingOriginalNextSibling = null;
		});

		container.addEventListener('dragend', () => {
			try {
				if (draggingId && !draggingDidDrop) {
					const dragged = document.getElementById(draggingId) as any;
					if (dragged) {
						if (draggingOriginalNextSibling && draggingOriginalNextSibling.parentElement === container) {
							container.insertBefore(dragged, draggingOriginalNextSibling);
						} else {
							container.appendChild(dragged);
						}
						resyncArraysFromDom();
						bestEffortRelayoutMovedEditors(draggingId);
						// Important: if the drop landed outside the container (e.g. over an editor/input),
						// the container 'drop' handler may not fire. Persist the reverted DOM order so
						// users can drag back to the original ordering and clear the dirty state.
						try { schedulePersist && schedulePersist('reorder'); } catch (e) { console.error('[kusto]', e); }
						// Refresh Data dropdowns in Chart/Transformation sections to update position labels
						try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			draggingId = '';
			draggingOriginalNextSibling = null;
			draggingDidDrop = false;
		});
	};

	tryInstall();
})();

// ==========================================================================
// RESPONSIVE TOOLBAR LAYOUT
// ==========================================================================
// The query header toolbar now uses CSS Container Queries for responsive layout.
// This is more reliable than JS-based measurement which could race with layout
// when new sections are added (causing incorrect minimal/ultra-compact states).
//
// See queryEditor*.css for the @container rules that handle:
//   - Minimal mode: dropdowns collapse to icon-only at <= 420px
//   - Ultra-compact: hide refresh/favorite/schema buttons at <= 200px
//
// The legacy is-minimal and is-ultra-compact classes are still supported in CSS
// for backwards compatibility, but are no longer added by JavaScript.
// ==========================================================================

// ==========================================================================
// ADD SECTION DROPDOWN (for narrow viewports)
// ==========================================================================
// Toggle the "Add Section" dropdown menu (shown at narrow widths < 465px).
function __kustoToggleAddSectionDropdown( event: any) {
	try {
		if (event) {
			event.stopPropagation();
		}
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		if (!btn || !menu) return;

		const wasOpen = menu.style.display === 'block';

		// Close all other dropdowns first.
		try {
			_closeAllDropdownMenus();
		} catch (e) { console.error('[kusto]', e); }

		if (wasOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
			return;
		}

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');

		// Apply visibility based on allowed section kinds.
		__kustoUpdateAddSectionDropdownVisibility();

	} catch (e) { console.error('[kusto]', e); }
}

// Called when a dropdown item is selected.
function __kustoAddSectionFromDropdown( kind: any) {
	try {
		// Close the dropdown.
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');

		// Add the section.
		__kustoRequestAddSection(kind);
	} catch (e) { console.error('[kusto]', e); }
}

// Update dropdown item visibility based on allowed section kinds (mirrors __kustoApplyDocumentCapabilities logic).
function __kustoUpdateAddSectionDropdownVisibility() {
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((v: any) => String(v))
			: ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];

		const items = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of items as any) {
			const kind = item.getAttribute('data-add-kind');
			if (allowed.length === 0 || allowed.includes(kind)) {
				item.style.display = '';
			} else {
				item.style.display = 'none';
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Close dropdown when clicking outside.
document.addEventListener('click', (event: any) => {
	try {
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		if (!menu || menu.style.display !== 'block') return;

		const target = event.target;
		if (target && typeof target.closest === 'function') {
			if (target.closest('.add-controls-dropdown')) {
				return; // Click inside dropdown, don't close.
			}
		}

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
});

// Close dropdown on Escape key.
document.addEventListener('keydown', (event: any) => {
	try {
		if (event.key !== 'Escape') return;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		if (!menu || menu.style.display !== 'block') return;

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
});

// ==========================================================================
// EVENT LISTENERS for static HTML elements (replace inline onclick handlers)
// ==========================================================================

// Add section buttons — delegated from .add-controls container using data-add-kind attribute.
try {
	const addControlsEl = document.querySelector('.add-controls');
	if (addControlsEl) {
		addControlsEl.addEventListener('click', (event: any) => {
			try {
				const btn = event.target?.closest?.('[data-add-kind]');
				if (!btn) return;
				const kind = btn.getAttribute('data-add-kind');
				if (!kind) return;
				// Dropdown items go through the dropdown handler.
				if (btn.classList.contains('add-controls-dropdown-item')) {
					__kustoAddSectionFromDropdown(kind);
				} else if (btn.classList.contains('add-controls-dropdown-btn')) {
					__kustoToggleAddSectionDropdown(event);
				} else {
					__kustoRequestAddSection(kind);
				}
			} catch (e) { console.error('[kusto]', e); }
		});
	}
} catch (e) { console.error('[kusto]', e); }

// Share modal — event listeners replacing inline onclick handlers.
try {
	const shareModal = document.getElementById('shareModal');
	if (shareModal) {
		// Backdrop click closes the modal.
		shareModal.addEventListener('click', (event: any) => {
			try { __kustoCloseShareModal(event); } catch (e) { console.error('[kusto]', e); }
		});
		// Stop propagation on content area.
		const content = document.getElementById('shareModalContent');
		if (content) content.addEventListener('click', (event: any) => event.stopPropagation());
		// Close button.
		const closeBtn = document.getElementById('shareModalCloseBtn');
		if (closeBtn) closeBtn.addEventListener('click', () => { try { __kustoCloseShareModal(); } catch (e) { console.error('[kusto]', e); } });
		// Copy button.
		const copyBtn = document.getElementById('shareModalCopyBtn');
		if (copyBtn) copyBtn.addEventListener('click', () => { try { __kustoShareCopyToClipboard(); } catch (e) { console.error('[kusto]', e); } });
	}
} catch (e) { console.error('[kusto]', e); }

// ── Window bridges for remaining legacy callers ──
window.__kustoGetFocusedMonacoEditor = __kustoGetFocusedMonacoEditor;
window.__kustoGetSelectionOrCurrentLineRange = __kustoGetSelectionOrCurrentLineRange;
window.__kustoCopyOrCutFocusedMonaco = __kustoCopyOrCutFocusedMonaco;
window.__kustoCopyOrCutMonacoEditorImpl = __kustoCopyOrCutMonacoEditorImpl;
window.__kustoToggleAddSectionDropdown = __kustoToggleAddSectionDropdown;
window.__kustoAddSectionFromDropdown = __kustoAddSectionFromDropdown;
window.__kustoUpdateAddSectionDropdownVisibility = __kustoUpdateAddSectionDropdownVisibility;
