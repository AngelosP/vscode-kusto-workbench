// Keyboard shortcuts & clipboard handlers — extracted from main.ts
// Registers document-level keyboard event listeners for paste, cut/copy,
// autocomplete triggers, execute query, modal dismiss, and focus management.
import {
	activeMonacoEditor, activeQueryEditorBoxId, setActiveQueryEditorBoxId,
	queryEditors, caretDocOverlaysByBoxId,
} from './state';
import { __kustoGetQuerySectionElement } from './queryBoxes';
import { __kustoEnsureAllEditorsWritableSoon } from './monaco-writable';
import { executeQuery } from './queryBoxes-execution';
import { safeRun } from '../shared/safe-run';

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
window.addEventListener('blur', () => safeRun('blur', () => {
	for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
		const overlay = caretDocOverlaysByBoxId[key];
		if (overlay && typeof overlay.hide === 'function') {
			overlay.hide();
		}
	}
	// Also reset any stuck resize-drag interaction state.
	if (document && document.body) {
		if (document.body.style && document.body.style.userSelect === 'none') {
			document.body.style.userSelect = '';
		}
		if (document.body.style && document.body.style.cursor === 'ns-resize') {
			document.body.style.cursor = '';
		}
	}
	(document.querySelectorAll('.query-editor-resizer.is-dragging') || []).forEach((el: any) => el.classList.remove('is-dragging'));
}));

// When the webview becomes active again, Monaco can occasionally end up with its hidden
// textarea stuck readonly/disabled. Re-assert writability for all editors.
window.addEventListener('focus', () => safeRun('focus', () => {
	__kustoEnsureAllEditorsWritableSoon();
}));

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

// ── Window bridges for remaining legacy callers ──
window.__kustoGetFocusedMonacoEditor = __kustoGetFocusedMonacoEditor;
window.__kustoGetSelectionOrCurrentLineRange = __kustoGetSelectionOrCurrentLineRange;
window.__kustoCopyOrCutFocusedMonaco = __kustoCopyOrCutFocusedMonaco;
window.__kustoCopyOrCutMonacoEditorImpl = __kustoCopyOrCutMonacoEditorImpl;
