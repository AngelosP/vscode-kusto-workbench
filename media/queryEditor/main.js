// VS Code can intercept Ctrl/Cmd+V in webviews; provide a reliable paste path for Monaco.
document.addEventListener('keydown', async (event) => {
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
	} catch {
		// ignore
	}

	// Prefer whichever Monaco editor actually has focus.
	// Only intercept paste when the editor TEXT area has focus, not widget focus.
	// Widget focus (like find widget) should handle its own paste.
	let editor = null;
	try {
		if (activeMonacoEditor && typeof activeMonacoEditor.hasTextFocus === 'function') {
			const hasTextFocus = activeMonacoEditor.hasTextFocus();
			if (hasTextFocus) {
				editor = activeMonacoEditor;
			}
		}
	} catch {
		// ignore
	}

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
		} catch {
			// ignore
		}
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
	} catch (e) {
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
		document.addEventListener('wheel', (event) => {
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
				try { window.scrollBy(dx, dy); } catch { /* ignore */ }
				try { event.preventDefault(); } catch { /* ignore */ }
				try { event.stopPropagation(); } catch { /* ignore */ }
			} catch {
				// ignore
			}
		}, { capture: true, passive: false });
	}
} catch {
	// ignore
}

// Close open modal dialogs on Escape.
// Only intercept Escape when a modal is visible, so we don't interfere with
// Monaco/editor keybindings during normal editing.
document.addEventListener('keydown', (event) => {
	try {
		if (!event || event.key !== 'Escape') {
			return;
		}

		let handled = false;

		// Diff View
		if (!handled) {
			try {
				const modal = document.getElementById('diffViewModal');
				if (modal && modal.classList && modal.classList.contains('visible')) {
					handled = true;
					if (typeof window.closeDiffView === 'function') {
						window.closeDiffView();
					} else {
						modal.classList.remove('visible');
					}
				}
			} catch { /* ignore */ }
		}

		// Object Viewer
		try {
			const modal = document.getElementById('objectViewer');
			if (modal && modal.classList && modal.classList.contains('visible')) {
				handled = true;
				if (typeof window.closeObjectViewer === 'function') {
					window.closeObjectViewer();
				} else {
					modal.classList.remove('visible');
				}
			}
		} catch { /* ignore */ }

		// Column Analysis
		if (!handled) {
			try {
				const modal = document.getElementById('columnAnalysisModal');
				if (modal && modal.classList && modal.classList.contains('visible')) {
					handled = true;
					if (typeof window.closeColumnAnalysis === 'function') {
						window.closeColumnAnalysis();
					} else {
						modal.classList.remove('visible');
					}
				}
			} catch { /* ignore */ }
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
						try { modal.remove(); } catch { /* ignore */ }
					}
				}
			} catch { /* ignore */ }
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
			} catch { /* ignore */ }
		}

		if (!handled) {
			return;
		}

		try { event.preventDefault(); } catch { /* ignore */ }
		try { event.stopPropagation(); } catch { /* ignore */ }
		try { event.stopImmediatePropagation(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}, true);

// VS Code can intercept Ctrl/Cmd+Space in webviews; provide a reliable autocomplete path for Monaco.
document.addEventListener('keydown', (event) => {
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
		try { event.preventDefault(); } catch { /* ignore */ }
		try { event.stopPropagation(); } catch { /* ignore */ }
		try { event.stopImmediatePropagation(); } catch { /* ignore */ }

		// Prefer the shared helper so we keep the "hide if no suggestions" behavior.
		try {
			const boxId = editor.__kustoBoxId;
			if (boxId && typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
				return;
			}
		} catch {
			// ignore
		}
		try {
			editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}, true);

// --- KQL language service bridge (webview -> extension host) ---
// Used to share a single semantic engine between the webview Monaco editor and VS Code text editors.
// If the bridge is unavailable or times out, callers should fall back to local heuristics.
let __kustoKqlLanguageRequestResolversById = {};

// --- Local resource URI resolver (webview -> extension host) ---
// Used to map markdown-relative paths (e.g. ./images/a.png) to webview-safe URIs.
let __kustoResourceUriRequestResolversById = {};

try {
	window.__kustoResolveResourceUri = async function (args) {
		const p = (args && typeof args.path === 'string') ? String(args.path) : '';
		const baseUri = (args && typeof args.baseUri === 'string') ? String(args.baseUri) : '';
		if (!p || !vscode || typeof vscode.postMessage !== 'function') {
			return null;
		}
		const requestId = 'resuri_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve) => {
			let timer = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoResourceUriRequestResolversById[requestId]; } catch { /* ignore */ }
					resolve(null);
				}, 2000);
			} catch { /* ignore */ }

			__kustoResourceUriRequestResolversById[requestId] = {
				resolve: (result) => {
					try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
					resolve(result);
				}
			};

			try {
				vscode.postMessage({
					type: 'resolveResourceUri',
					requestId,
					path: p,
					baseUri
				});
			} catch {
				try { delete __kustoResourceUriRequestResolversById[requestId]; } catch { /* ignore */ }
				try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
				resolve(null);
			}
		});
	};
} catch {
	// ignore
}

try {
	window.__kustoRequestKqlDiagnostics = async function (args) {
		const text = (args && typeof args.text === 'string') ? args.text : '';
		const connectionId = (args && typeof args.connectionId === 'string') ? args.connectionId : '';
		const database = (args && typeof args.database === 'string') ? args.database : '';
		const boxId = (args && typeof args.boxId === 'string') ? args.boxId : '';
		if (!vscode || typeof vscode.postMessage !== 'function') {
			return null;
		}
		const requestId = 'kqlreq_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve) => {
			let timer = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch { /* ignore */ }
					resolve(null);
				}, 1500);
			} catch { /* ignore */ }

			__kustoKqlLanguageRequestResolversById[requestId] = {
				resolve: (result) => {
					try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
					resolve(result);
				}
			};

			try {
				vscode.postMessage({
					type: 'kqlLanguageRequest',
					requestId,
					method: 'textDocument/diagnostic',
					params: { text, connectionId, database, boxId }
				});
			} catch {
				try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch { /* ignore */ }
				try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
				resolve(null);
			}
		});
	};
} catch {
	// ignore
}

try {
	window.__kustoRequestKqlTableReferences = async function (args) {
		const text = (args && typeof args.text === 'string') ? args.text : '';
		const connectionId = (args && typeof args.connectionId === 'string') ? args.connectionId : '';
		const database = (args && typeof args.database === 'string') ? args.database : '';
		const boxId = (args && typeof args.boxId === 'string') ? args.boxId : '';
		if (!vscode || typeof vscode.postMessage !== 'function') {
			return null;
		}
		const requestId = 'kqlreq_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve) => {
			let timer = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch { /* ignore */ }
					resolve(null);
				}, 1500);
			} catch { /* ignore */ }

			__kustoKqlLanguageRequestResolversById[requestId] = {
				resolve: (result) => {
					try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
					resolve(result);
				}
			};

			try {
				vscode.postMessage({
					type: 'kqlLanguageRequest',
					requestId,
					method: 'kusto/findTableReferences',
					params: { text, connectionId, database, boxId }
				});
			} catch {
				try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch { /* ignore */ }
				try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
				resolve(null);
			}
		});
	};
} catch {
	// ignore
}

function __kustoGetFocusedMonacoEditor() {
	// Prefer whichever Monaco editor actually has focus.
	let editor = null;
	try {
		if (activeMonacoEditor && typeof activeMonacoEditor.hasTextFocus === 'function') {
			const hasFocus = activeMonacoEditor.hasTextFocus() ||
				(typeof activeMonacoEditor.hasWidgetFocus === 'function' && activeMonacoEditor.hasWidgetFocus());
			if (hasFocus) {
				editor = activeMonacoEditor;
			}
		}
	} catch {
		// ignore
	}

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
		} catch {
			// ignore
		}
	}
	return editor;
}

// --- Toolbar focus behavior ---
// Goal: when the Monaco editor has focus and the user clicks toolbar buttons (normal, toggle,
// dropdown) with the mouse, don't leave focus on the button; return focus to Monaco.
// We do this in a central place because toolbar HTML is generated dynamically.
(function __kustoInitToolbarMouseFocusBehavior() {
	const focusEditorForTarget = (target) => {
		try {
			// Prefer focusing the editor for the query box that owns the toolbar/menu.
			const t = target && target.closest ? target : null;
			const box = t ? t.closest('.query-box') : null;
			const boxId = box && typeof box.id === 'string' ? box.id : '';
			if (boxId && typeof queryEditors === 'object' && queryEditors && queryEditors[boxId] && typeof queryEditors[boxId].focus === 'function') {
				try { activeQueryEditorBoxId = boxId; } catch { /* ignore */ }
				queryEditors[boxId].focus();
				return;
			}
		} catch { /* ignore */ }

		// Fallback: focus whichever Monaco editor is currently focused/active.
		try {
			const editor = (typeof __kustoGetFocusedMonacoEditor === 'function') ? __kustoGetFocusedMonacoEditor() : null;
			if (editor && typeof editor.focus === 'function') {
				editor.focus();
			}
		} catch { /* ignore */ }
	};

	// Prevent mouse focus from moving onto toolbar buttons.
	document.addEventListener('mousedown', (ev) => {
		try {
			const e = ev || window.event;
			if (!e || e.button !== 0) return;
			const t = e.target;
			if (!t || !t.closest) return;
			if (t.closest('.query-editor-toolbar') || t.closest('.qe-toolbar-dropdown-menu') || t.closest('.qe-toolbar-overflow-menu')) {
				// Prevent the browser from focusing the clicked element.
				e.preventDefault();
			}
		} catch { /* ignore */ }
	}, true);

	// After toolbar clicks, return focus to Monaco.
	// Important: do NOT do this for the dropdown *toggle* button itself, otherwise we would
	// immediately steal focus from the opened menu and close it.
	document.addEventListener('click', (ev) => {
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
		} catch { /* ignore */ }
	}, true);
})();

function __kustoGetSelectionOrCurrentLineRange(editor) {
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

async function __kustoCopyOrCutFocusedMonaco(event, isCut) {
	const editor = __kustoGetFocusedMonacoEditor();
	if (!editor) {
		return;
	}
	await __kustoCopyOrCutMonacoEditorImpl(editor, event, isCut);
}

async function __kustoCopyOrCutMonacoEditorImpl(editor, eventOrNull, isCut) {
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
		} catch {
			// ignore
		}
		if (isCut) {
			try {
				editor.executeEdits('clipboard', [{ range, text: '' }]);
			} catch { /* ignore */ }
		}
		try { editor.focus(); } catch { /* ignore */ }
		return true;
	} catch {
		// If clipboard write isn't permitted, fall back to default behavior.
		// (Do not preventDefault in this case.)
		return false;
	}
}

// Expose for Monaco context-menu action overrides.
try {
	window.__kustoCopyOrCutMonacoEditor = async function (editor, isCut) {
		return await __kustoCopyOrCutMonacoEditorImpl(editor, null, !!isCut);
	};
} catch {
	// ignore
}

// VS Code can intercept Ctrl/Cmd+X/C; provide reliable cut/copy paths for Monaco.
document.addEventListener('keydown', (event) => {
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
document.addEventListener('cut', (event) => {
	void __kustoCopyOrCutFocusedMonaco(event, true);
}, true);
document.addEventListener('copy', (event) => {
	void __kustoCopyOrCutFocusedMonaco(event, false);
}, true);

// Ctrl+Enter / Ctrl+Shift+Enter (Cmd+Enter / Cmd+Shift+Enter on macOS) runs the active query box,
// same as clicking the main run button. Also submits Copilot Chat if focused.
document.addEventListener('keydown', (event) => {
	// Some environments report Enter via `code` more reliably than `key`.
	const isEnter = (event.key === 'Enter') || (event.code === 'Enter');
	if (!(event.ctrlKey || event.metaKey) || !isEnter) {
		return;
	}
	if (!activeQueryEditorBoxId) {
		return;
	}

	// Check if focus is on the Copilot Chat input textarea
	const activeEl = document.activeElement;
	if (activeEl && activeEl.id === activeQueryEditorBoxId + '_copilot_input') {
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === 'function') {
			event.stopImmediatePropagation();
		}
		try {
			if (typeof __kustoCopilotWriteQuerySend === 'function') {
				__kustoCopilotWriteQuerySend(activeQueryEditorBoxId);
			}
		} catch {
			// ignore
		}
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
	} catch {
		// ignore
	}
}, true);

// F1 should show the Monaco hover tooltip (docs) when inside the editor.
document.addEventListener('keydown', (event) => {
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
	} catch {
		// ignore
	}
	try {
		editor.trigger('keyboard', 'editor.action.showHover', {});
	} catch {
		// ignore
	}
}, true);

// Escape hides the custom caret tooltip overlay (without interfering with Monaco default behavior).
document.addEventListener('keydown', (event) => {
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
	} catch {
		// ignore
	}
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
	} catch {
		// ignore
	}
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
			(document.querySelectorAll('.query-editor-resizer.is-dragging') || []).forEach(el => el.classList.remove('is-dragging'));
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
});

// When the webview becomes active again, Monaco can occasionally end up with its hidden
// textarea stuck readonly/disabled. Re-assert writability for all editors.
window.addEventListener('focus', () => {
	try {
		if (typeof __kustoEnsureAllEditorsWritableSoon === 'function') {
			__kustoEnsureAllEditorsWritableSoon();
		}
	} catch {
		// ignore
	}
});

document.addEventListener('visibilitychange', () => {
	try {
		if (!document.hidden && typeof __kustoEnsureAllEditorsWritableSoon === 'function') {
			__kustoEnsureAllEditorsWritableSoon();
		}
	} catch {
		// ignore
	}
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
			(document.querySelectorAll('.query-editor-resizer.is-dragging') || []).forEach(el => el.classList.remove('is-dragging'));
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
});

window.addEventListener('message', async event => {
	const message = (event && event.data && typeof event.data === 'object') ? event.data : {};
	const messageType = String(message.type || '');
	switch (messageType) {
		case 'controlCommandSyntaxResult':
			try {
				const commandLower = String(message.commandLower || '').trim();
				if (commandLower) {
					try {
						if (!window.__kustoControlCommandDocCache || typeof window.__kustoControlCommandDocCache !== 'object') {
							window.__kustoControlCommandDocCache = {};
						}
					} catch { /* ignore */ }
					try {
						const ok = !!message.ok;
						const syntax = ok && typeof message.syntax === 'string' ? String(message.syntax) : '';
						const withArgs = ok && Array.isArray(message.withArgs) ? message.withArgs.map(s => String(s)) : [];
						window.__kustoControlCommandDocCache[commandLower] = {
							syntax,
							withArgs,
							fetchedAt: Date.now()
						};
					} catch { /* ignore */ }
					try {
						if (window.__kustoControlCommandDocPending && typeof window.__kustoControlCommandDocPending === 'object') {
							delete window.__kustoControlCommandDocPending[commandLower];
						}
					} catch { /* ignore */ }
					try {
						if (typeof window.__kustoRefreshActiveCaretDocs === 'function') {
							window.__kustoRefreshActiveCaretDocs();
						}
					} catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
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
					if (typeof optimizeQueryWithCopilot === 'function') {
						comparisonBoxId = await optimizeQueryWithCopilot(boxId, query, { skipExecute: true });
					}
				} catch { /* ignore */ }
				try {
					vscode.postMessage({
						type: 'comparisonBoxEnsured',
						requestId,
						sourceBoxId: boxId,
						comparisonBoxId: String(comparisonBoxId || '')
					});
				} catch { /* ignore */ }
			} catch { /* ignore */ }
			break;
		case 'persistenceMode':
				try {
					window.__kustoIsSessionFile = !!message.isSessionFile;
					try {
						if (typeof message.documentUri === 'string') {
							window.__kustoDocumentUri = String(message.documentUri);
						}
					} catch { /* ignore */ }
						try {
							if (typeof message.documentKind === 'string') {
								window.__kustoDocumentKind = String(message.documentKind);
								try {
									if (document && document.body && document.body.dataset) {
										document.body.dataset.kustoDocumentKind = String(message.documentKind);
									}
								} catch { /* ignore */ }
							}
						} catch { /* ignore */ }
						try {
							if (Array.isArray(message.allowedSectionKinds)) {
								window.__kustoAllowedSectionKinds = message.allowedSectionKinds.map(k => String(k));
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
						} catch { /* ignore */ }
							if (typeof __kustoSetCompatibilityMode === 'function') {
								__kustoSetCompatibilityMode(!!message.compatibilityMode);
							} else {
								window.__kustoCompatibilityMode = !!message.compatibilityMode;
							}
						try {
							if (typeof __kustoApplyDocumentCapabilities === 'function') {
								__kustoApplyDocumentCapabilities();
							}
						} catch { /* ignore */ }
				} catch {
					// ignore
				}
				break;
		case 'upgradedToKqlx':
			// The extension host has upgraded the file format from .kql/.csl to .kqlx.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				if (typeof __kustoSetCompatibilityMode === 'function') {
					__kustoSetCompatibilityMode(false);
				} else {
					window.__kustoCompatibilityMode = false;
				}
			} catch { /* ignore */ }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k && typeof __kustoRequestAddSection === 'function') {
					__kustoRequestAddSection(k);
				}
			} catch { /* ignore */ }
			break;
		case 'enabledKqlxSidecar':
			// The extension host has enabled a companion .kqlx metadata file for a .kql/.csl document.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				if (typeof __kustoSetCompatibilityMode === 'function') {
					__kustoSetCompatibilityMode(false);
				} else {
					window.__kustoCompatibilityMode = false;
				}
			} catch { /* ignore */ }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k && typeof __kustoRequestAddSection === 'function') {
					__kustoRequestAddSection(k);
				}
			} catch { /* ignore */ }
			break;
		case 'connectionsData':
			connections = message.connections;
			lastConnectionId = message.lastConnectionId;
			lastDatabase = message.lastDatabase;
			cachedDatabases = message.cachedDatabases || {};
			kustoFavorites = Array.isArray(message.favorites) ? message.favorites : [];
			leaveNoTraceClusters = Array.isArray(message.leaveNoTraceClusters) ? message.leaveNoTraceClusters : [];
			caretDocsEnabled = (typeof message.caretDocsEnabled === 'boolean') ? message.caretDocsEnabled : true;
			autoTriggerAutocompleteEnabled = (typeof message.autoTriggerAutocompleteEnabled === 'boolean') ? message.autoTriggerAutocompleteEnabled : true;
			copilotInlineCompletionsEnabled = (typeof message.copilotInlineCompletionsEnabled === 'boolean') ? message.copilotInlineCompletionsEnabled : true;
			try {
				// Indicates whether the user has explicitly chosen a value (on/off) before.
				// When true, document-level restore should not override this global preference.
				window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet;
			} catch { /* ignore */ }
			try {
				window.__kustoAutoTriggerAutocompleteEnabledUserSet = !!message.autoTriggerAutocompleteEnabledUserSet;
			} catch { /* ignore */ }
			try {
				window.__kustoCopilotInlineCompletionsEnabledUserSet = !!message.copilotInlineCompletionsEnabledUserSet;
			} catch { /* ignore */ }
			updateConnectionSelects();
			try {
				if (typeof window.__kustoUpdateFavoritesUiForAllBoxes === 'function') {
					window.__kustoUpdateFavoritesUiForAllBoxes();
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoTryAutoEnterFavoritesModeForAllBoxes === 'function') {
					window.__kustoTryAutoEnterFavoritesModeForAllBoxes();
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoMaybeDefaultFirstBoxToFavoritesMode === 'function') {
					window.__kustoMaybeDefaultFirstBoxToFavoritesMode();
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoOnConnectionsUpdated === 'function') {
					window.__kustoOnConnectionsUpdated();
				}
			} catch { /* ignore */ }
			try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch { /* ignore */ }
			try { updateCopilotInlineCompletionsToggleButtons(); } catch { /* ignore */ }
			break;
		case 'favoritesData':
			kustoFavorites = Array.isArray(message.favorites) ? message.favorites : [];
			try {
				if (typeof window.__kustoUpdateFavoritesUiForAllBoxes === 'function') {
					window.__kustoUpdateFavoritesUiForAllBoxes();
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoTryAutoEnterFavoritesModeForAllBoxes === 'function') {
					window.__kustoTryAutoEnterFavoritesModeForAllBoxes();
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoMaybeDefaultFirstBoxToFavoritesMode === 'function') {
					window.__kustoMaybeDefaultFirstBoxToFavoritesMode();
				}
			} catch { /* ignore */ }
			// If this update came from an "Add favorite" action in a specific box, automatically
			// switch that box into Favorites mode.
			try {
				const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
				if (boxId && Array.isArray(kustoFavorites) && kustoFavorites.length > 0) {
					if (typeof window.__kustoEnterFavoritesModeForBox === 'function') {
						window.__kustoEnterFavoritesModeForBox(boxId);
					}
				}
			} catch { /* ignore */ }
			break;
		case 'confirmRemoveFavoriteResult':
			try {
				if (typeof window.__kustoOnConfirmRemoveFavoriteResult === 'function') {
					window.__kustoOnConfirmRemoveFavoriteResult(message);
				}
			} catch { /* ignore */ }
			break;
		case 'documentData':
			try {
				if (typeof handleDocumentDataMessage === 'function') {
					handleDocumentDataMessage(message);
				}
			} catch {
				// ignore
			}
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
					vscode.postMessage({
						type: 'debugMdSearchReveal',
						phase: 'revealTextRange(received)',
						detail: `${String(message.documentUri || '')} ${sl}:${sc}-${el}:${ec} matchLen=${matchLen}`
					});
				} catch { /* ignore */ }
				if (typeof window.__kustoRevealTextRangeFromHost === 'function') {
					window.__kustoRevealTextRangeFromHost(message);
					try {
						vscode.postMessage({
							type: 'debugMdSearchReveal',
							phase: 'revealTextRange(dispatched)',
							detail: `${String(message.documentUri || '')}`
						});
					} catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
			break;
		case 'resolveResourceUriResult':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoResourceUriRequestResolversById && __kustoResourceUriRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					const uri = (message && message.ok && typeof message.uri === 'string') ? String(message.uri) : null;
					try { r.resolve(uri); } catch { /* ignore */ }
					try { delete __kustoResourceUriRequestResolversById[reqId]; } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			break;
		case 'kqlLanguageResponse':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoKqlLanguageRequestResolversById && __kustoKqlLanguageRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					try {
						r.resolve(message.ok ? (message.result || null) : null);
					} catch { /* ignore */ }
					try { delete __kustoKqlLanguageRequestResolversById[reqId]; } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
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
					} catch { /* ignore */ }
					const list = (Array.isArray(message.databases) ? message.databases : [])
						.map(d => String(d || '').trim())
						.filter(Boolean)
						.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
					try {
						if (cid) {
							let clusterKey = '';
							try {
								const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '').trim() === String(cid || '').trim()) : null;
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
							} catch { /* ignore */ }
							if (clusterKey) {
								cachedDatabases[clusterKey] = list;
							}
						}
					} catch { /* ignore */ }
					try { r.resolve(list); } catch { /* ignore */ }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }

			updateDatabaseSelect(message.boxId, message.databases, message.connectionId);
			break;
		case 'databasesError':
			// Reject pending database list request if this was a synthetic request id.
			try {
				const r = databasesRequestResolversByBoxId && databasesRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message && message.error ? String(message.error) : 'Failed to load databases.')); } catch { /* ignore */ }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }
			try {
				if (typeof onDatabasesError === 'function') {
					onDatabasesError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.', message.connectionId);
				} else if (typeof window.__kustoDisplayBoxError === 'function') {
					window.__kustoDisplayBoxError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.');
				}
			} catch {
				// ignore
			}
			break;
		case 'importConnectionsXmlText':
			try {
				const text = (typeof message.text === 'string') ? message.text : '';
				const imported = (typeof parseKustoExplorerConnectionsXml === 'function')
					? parseKustoExplorerConnectionsXml(text)
					: [];
				if (!imported || !imported.length) {
					try { vscode.postMessage({ type: 'showInfo', message: 'No connections found in the selected XML file.' }); } catch { /* ignore */ }
					break;
				}
				vscode.postMessage({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });
			} catch (e) {
				try { vscode.postMessage({ type: 'showInfo', message: 'Failed to import connections: ' + (e && e.message ? e.message : String(e)) }); } catch { /* ignore */ }
			}
			break;
		case 'importConnectionsXmlError':
			try { vscode.postMessage({ type: 'showInfo', message: 'Failed to import connections: ' + (message && message.error ? String(message.error) : 'Unknown error') }); } catch { /* ignore */ }
			break;
		case 'queryResult':
			try {
				if (message.boxId) {
					window.lastExecutedBox = message.boxId;
				}
			} catch {
				// ignore
			}
			try {
				// Always target the concrete boxId when available (prevents races when
				// multiple queries are running and keeps comparison summaries in sync).
				if (message.boxId && (typeof displayResultForBox === 'function' || typeof window.displayResultForBox === 'function')) {
					try {
						if (typeof setQueryExecuting === 'function') {
							setQueryExecuting(message.boxId, false);
						}
					} catch { /* ignore */ }
					if (typeof displayResultForBox === 'function') {
						displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
					} else {
						window.displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
					}
				} else if (typeof displayResult === 'function') {
					displayResult(message.result);
				} else if (typeof window.displayResult === 'function') {
					window.displayResult(message.result);
				} else {
					console.error('Query result received, but no results renderer is available (displayResult/displayResultForBox).');
				}
			} catch (e) {
				console.error('Failed to render query results:', e);
			}
			try {
				if (message.boxId && typeof __kustoOnQueryResult === 'function') {
					__kustoOnQueryResult(message.boxId, message.result);
				}
			} catch {
				// ignore
			}
			// Check if this is a comparison box result
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId]) {
					const metadata = optimizationMetadataByBoxId[message.boxId];
					if (metadata.isComparison && metadata.sourceBoxId) {
						// Check if source box has results too
						const sourceState = __kustoGetResultsState(metadata.sourceBoxId);
						const comparisonState = __kustoGetResultsState(message.boxId);
						if (sourceState && comparisonState) {
							displayComparisonSummary(metadata.sourceBoxId, message.boxId);
						}
					}
				}
			} catch (err) {
				console.error('Error displaying comparison summary:', err);
			}
			// Also handle the inverse: source box result arrives after comparison
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId] && optimizationMetadataByBoxId[message.boxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[message.boxId].comparisonBoxId;
					const sourceState = __kustoGetResultsState(message.boxId);
					const comparisonState = __kustoGetResultsState(comparisonBoxId);
					if (sourceState && comparisonState) {
						displayComparisonSummary(message.boxId, comparisonBoxId);
					}
				}
			} catch {
				// ignore
			}
			break;
		case 'queryError':
			try {
				if (message && message.boxId) {
					window.lastExecutedBox = message.boxId;
				}
			} catch {
				// ignore
			}
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : (window.lastExecutedBox ? String(window.lastExecutedBox) : '');
				const err = (message && 'error' in message) ? message.error : 'Query execution failed.';
				try {
					if (boxId && typeof setQueryExecuting === 'function') {
						setQueryExecuting(boxId, false);
					}
				} catch { /* ignore */ }
				if (boxId && typeof window.__kustoRenderErrorUx === 'function') {
					window.__kustoRenderErrorUx(boxId, err);
				} else if (typeof displayError === 'function') {
					displayError(err);
				} else {
					console.error('Query error (no error renderer available):', err);
				}
			} catch (e) {
				console.error('Failed to render query error:', e);
			}
			break;
		case 'queryCancelled':
			try {
				if (message.boxId) {
					window.lastExecutedBox = message.boxId;
				}
			} catch {
				// ignore
			}
			if (typeof displayCancelled === 'function') {
				displayCancelled();
			} else {
				displayError('Cancelled');
			}
			break;
		case 'ensureResultsVisible':
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : '';
				if (boxId) {
					// Prefer the canonical setter so the toggle button and wrapper stay in sync.
					if (typeof __kustoSetResultsVisible === 'function') {
						__kustoSetResultsVisible(boxId, true);
					} else if (typeof __kustoEnsureResultsShownForTool === 'function') {
						__kustoEnsureResultsShownForTool(boxId);
					}
				}
			} catch {
				// ignore
			}
			break;
		case 'pythonResult':
			try { if (typeof onPythonResult === 'function') onPythonResult(message); } catch { /* ignore */ }
			break;
		case 'pythonError':
			try { if (typeof onPythonError === 'function') onPythonError(message); } catch { /* ignore */ }
			break;
		case 'urlContent':
			try { if (typeof onUrlContent === 'function') onUrlContent(message); } catch { /* ignore */ }
			break;
		case 'urlError':
			try { if (typeof onUrlError === 'function') onUrlError(message); } catch { /* ignore */ }
			break;
		case 'schemaData':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && window && window.__kustoSchemaRequestTokenByBoxId) {
					const expected = window.__kustoSchemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch { /* ignore */ }
			
			try {
				const cid = String(message.connectionId || '').trim();
				const db = String(message.database || '').trim();
				if (cid && db) {
					schemaByConnDb[cid + '|' + db] = message.schema;
				}
			} catch { /* ignore */ }

			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.resolve === 'function') {
					try { r.resolve(message.schema); } catch { /* ignore */ }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }

			// Normal per-editor schema update (autocomplete).
			// This is the SINGLE source of truth for schema data - no duplicate caching
			schemaByBoxId[message.boxId] = message.schema;
			setSchemaLoading(message.boxId, false);
			
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
				
				if (shouldUpdate) {
					const applySchema = async () => {
						if (typeof window.__kustoSetMonacoKustoSchema === 'function') {
							// Schema/context state in monaco-kusto is tracked PER Monaco model URI.
							// If we don't pass the model URI, monaco.js falls back to models[0], which can
							// immediately put the wrong database in context for the active editor.
							let modelUri = null;
							try {
								const editor = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[message.boxId] : null;
								const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
								if (model && model.uri) {
									modelUri = model.uri.toString();
								}
							} catch { /* ignore */ }

							// If we can't resolve a model URI yet (editor not ready), retry later.
							if (!modelUri) {
								return false;
							}

							// Set as context if this is the active box
							await window.__kustoSetMonacoKustoSchema(message.schema.rawSchemaJson, message.clusterUrl, message.database, isActiveBox, modelUri);
							
							// If this is the active box, trigger revalidation to reflect the new schema
							if (isActiveBox && typeof window.__kustoTriggerRevalidation === 'function') {
								window.__kustoTriggerRevalidation(message.boxId);
							}
							return true;
						}
						return false;
					};
					
					// Try immediately
					applySchema().then(success => {
						if (!success) {
							// If function not available yet, retry after monaco-kusto loads
							const retryDelays = [100, 300, 600, 1000, 2000];
							let retryIndex = 0;
							const retry = () => {
								if (retryIndex < retryDelays.length) {
									setTimeout(() => {
										applySchema().then(applied => {
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
			} catch (e) { console.error('[schemaData] Error:', e); }
			
			// NOTE: Custom diagnostics are disabled - monaco-kusto handles validation
			// try {
			// 	if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
			// 		window.__kustoScheduleKustoDiagnostics(message.boxId, 0);
			// 	}
			// } catch { /* ignore */ }
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
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
				
				setSchemaLoadedSummary(
					message.boxId,
					displayText,
					tooltipText,
					isError,
					{ fromCache: !!meta.fromCache, tablesCount, columnsCount, hasRawSchemaJson, isFailoverToCache }
				);
			}
			break;
		case 'schemaError':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && window && window.__kustoSchemaRequestTokenByBoxId) {
					const expected = window.__kustoSchemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch { /* ignore */ }
			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message.error || 'Schema fetch failed')); } catch { /* ignore */ }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }
			// Non-fatal; keep any previously loaded schema + counts if present.
			setSchemaLoading(message.boxId, false);
			try {
				const hasSchema = !!(schemaByBoxId && schemaByBoxId[message.boxId]);
				if (!hasSchema) {
					setSchemaLoadedSummary(message.boxId, 'Schema failed', message.error || 'Schema fetch failed', true);
				}
			} catch {
				try {
					setSchemaLoadedSummary(message.boxId, 'Schema failed', message.error || 'Schema fetch failed', true);
				} catch { /* ignore */ }
			}
			try {
				if (typeof window.__kustoDisplayBoxError === 'function') {
					window.__kustoDisplayBoxError(message.boxId, message.error || 'Schema fetch failed');
				}
			} catch {
				// ignore
			}
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
			} catch (e) {
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
				if (typeof window.__kustoCrossClusterSchemas !== 'undefined') {
					window.__kustoCrossClusterSchemas[key] = { status: 'error', error: message.error };
				}
			} catch {
				// ignore
			}
			break;
			case 'connectionAdded':
				// Refresh list and preselect the new connection in the originating box.
				if (Array.isArray(message.connections)) {
					connections = message.connections;
				}
				if (message.lastConnectionId) {
					lastConnectionId = message.lastConnectionId;
				}
				if (typeof message.lastDatabase === 'string') {
					lastDatabase = message.lastDatabase;
				}
				updateConnectionSelects();
				try {
					if (typeof window.__kustoOnConnectionsUpdated === 'function') {
						window.__kustoOnConnectionsUpdated();
					}
				} catch { /* ignore */ }
				try {
					const boxId = message.boxId || null;
					if (boxId && message.connectionId) {
						const sel = document.getElementById(boxId + '_connection');
						if (sel) {
							sel.value = message.connectionId;
							sel.dataset.prevValue = message.connectionId;
							updateDatabaseField(boxId);
						}
					}
				} catch {
					// ignore
				}
				break;
		case 'copilotAvailability':
			try {
				const boxId = message.boxId || '';
				const available = !!message.available;
				// Per-editor toolbar toggle button
				try {
					const applyToButton = (btn) => {
						if (!btn) return;
						const inProgress = !!(btn.dataset && btn.dataset.kustoCopilotChatInProgress === '1');
						if (!available) {
							btn.disabled = true;
							try { if (btn.dataset) btn.dataset.kustoDisabledByCopilot = '1'; } catch { /* ignore */ }
							btn.title = 'Copilot chat\n\nGitHub Copilot is required for this feature. Enable Copilot in VS Code to use Copilot-assisted query writing.';
							btn.setAttribute('aria-disabled', 'true');
						} else {
							const disabledByCopilot = !!(btn.dataset && btn.dataset.kustoDisabledByCopilot === '1');
							if (disabledByCopilot) {
								try { if (btn.dataset) delete btn.dataset.kustoDisabledByCopilot; } catch { /* ignore */ }
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
					} else {
						applyToButton(document.getElementById(boxId + '_copilot_chat_toggle'));
					}
				} catch { /* ignore */ }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
				if (optimizeBtn) {
					// The "Compare two queries" button does not require Copilot.
					try {
						if (optimizeBtn.dataset) {
							delete optimizeBtn.dataset.kustoDisabledByCopilot;
							delete optimizeBtn.dataset.kustoCopilotAvailable;
						}
					} catch { /* ignore */ }
					optimizeBtn.title = 'Compare two queries';
					optimizeBtn.setAttribute('aria-label', 'Compare two queries');
					// Do not forcibly enable if some other flow disabled it (e.g. query box is removed).
					// Only undo any Copilot-based disabling.
					try {
						if (optimizeBtn.disabled && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeInProgress !== '1') {
							optimizeBtn.disabled = false;
						}
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			break;
		case 'optimizeQueryStatus':
			try {
				const boxId = message.boxId || '';
				const status = message.status || '';
				try {
					if (typeof __kustoSetOptimizeInProgress === 'function') {
						__kustoSetOptimizeInProgress(boxId, true, status);
					} else if (typeof __kustoUpdateOptimizeStatus === 'function') {
						__kustoUpdateOptimizeStatus(boxId, status);
					}
				} catch { /* ignore */ }
			} catch { /* ignore */ }
			break;
		case 'compareQueryPerformanceWithQuery':
			try {
				const boxId = String(message.boxId || '');
				const query = String(message.query || '');
				if (boxId && typeof optimizeQueryWithCopilot === 'function') {
					Promise.resolve(optimizeQueryWithCopilot(boxId, query));
				}
			} catch { /* ignore */ }
			break;
		case 'optimizeQueryReady':
			try {
				const sourceBoxId = message.boxId || '';
				try {
					if (typeof __kustoSetOptimizeInProgress === 'function') {
						__kustoSetOptimizeInProgress(sourceBoxId, false, '');
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoHideOptimizePromptForBox === 'function') {
						__kustoHideOptimizePromptForBox(sourceBoxId);
					}
				} catch { /* ignore */ }
				const optimizedQuery = message.optimizedQuery || '';
				let queryName = message.queryName || '';
				// Ensure the source section has a name for optimization.
				// If missing, assign the next unused letter (A, B, C, ...).
				try {
					const nameEl = document.getElementById(sourceBoxId + '_name');
					if (nameEl) {
						let sourceName = String(nameEl.value || '').trim();
						if (!sourceName && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
							sourceName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
							nameEl.value = sourceName;
							try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
						}
						if (sourceName) {
							queryName = sourceName;
						}
					}
				} catch { /* ignore */ }
				// Fallback: if we still don't have a name (e.g. input missing), pick one.
				if (!String(queryName || '').trim() && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
					try {
						queryName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
					} catch { /* ignore */ }
				}
				const desiredOptimizedName = String(queryName || '').trim() ? (String(queryName || '').trim() + ' (optimized)') : '';
				const connectionId = message.connectionId || '';
				const database = message.database || '';
				let prettifiedOptimizedQuery = optimizedQuery;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						prettifiedOptimizedQuery = window.__kustoPrettifyKustoText(optimizedQuery);
					}
				} catch { /* ignore */ }
				
				// If a comparison box already exists for this source, reuse it.
				if (optimizationMetadataByBoxId[sourceBoxId] && optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId;
					const comparisonEditor = queryEditors && queryEditors[comparisonBoxId];
					if (comparisonBoxId && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
						try {
							comparisonEditor.setValue(prettifiedOptimizedQuery);
							try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
						} catch { /* ignore */ }
						// Name the optimized section "<source name> (optimized)".
						try {
							const nameEl = document.getElementById(comparisonBoxId + '_name');
							if (nameEl) {
								if (desiredOptimizedName) {
									nameEl.value = desiredOptimizedName;
									try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
								}
							}
						} catch { /* ignore */ }
						try {
							optimizationMetadataByBoxId[comparisonBoxId] = optimizationMetadataByBoxId[comparisonBoxId] || {};
							optimizationMetadataByBoxId[comparisonBoxId].sourceBoxId = sourceBoxId;
							optimizationMetadataByBoxId[comparisonBoxId].isComparison = true;
							optimizationMetadataByBoxId[comparisonBoxId].originalQuery = queryEditors[sourceBoxId] ? queryEditors[sourceBoxId].getValue() : '';
							optimizationMetadataByBoxId[comparisonBoxId].optimizedQuery = prettifiedOptimizedQuery;
						} catch { /* ignore */ }
						try {
							if (typeof __kustoSetLinkedOptimizationMode === 'function') {
								__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
							}
						} catch { /* ignore */ }
						try {
							if (typeof __kustoSetResultsVisible === 'function') {
								__kustoSetResultsVisible(sourceBoxId, false);
								__kustoSetResultsVisible(comparisonBoxId, false);
							}
						} catch { /* ignore */ }
						try {
							executeQuery(sourceBoxId);
							setTimeout(() => {
								try { executeQuery(comparisonBoxId); } catch { /* ignore */ }
							}, 100);
						} catch { /* ignore */ }
					}

					// Restore the optimize button state on source box
					const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn');
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
					if (typeof __kustoSetResultsVisible === 'function') {
						__kustoSetResultsVisible(sourceBoxId, false);
						__kustoSetResultsVisible(comparisonBoxId, false);
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetLinkedOptimizationMode === 'function') {
						__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
					}
				} catch { /* ignore */ }
				
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
					const sourceBox = document.getElementById(sourceBoxId);
					const comparisonBox = document.getElementById(comparisonBoxId);
					if (sourceBox && comparisonBox && sourceBox.parentNode && comparisonBox.parentNode) {
						sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
					}
				} catch { /* ignore */ }
				
				// Set connection and database to match source
				const comparisonConnSelect = document.getElementById(comparisonBoxId + '_connection');
				const comparisonDbSelect = document.getElementById(comparisonBoxId + '_database');
				if (comparisonConnSelect) {
					comparisonConnSelect.value = connectionId;
					comparisonConnSelect.dataset.prevValue = connectionId;
					updateDatabaseField(comparisonBoxId);
					
					// After database field updates, set the database value
					setTimeout(() => {
						if (comparisonDbSelect) {
							comparisonDbSelect.value = database;
						}
					}, 100);
				}
				
				// Set the query name
				const comparisonNameInput = document.getElementById(comparisonBoxId + '_name');
				if (comparisonNameInput) {
					if (desiredOptimizedName) {
						comparisonNameInput.value = desiredOptimizedName;
					}
				}
				
				// Execute both queries for comparison
				executeQuery(sourceBoxId);
				setTimeout(() => {
					executeQuery(comparisonBoxId);
				}, 100);
				
				// Restore the optimize button state on source box
				const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn');
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (err) {
				console.error('Error creating comparison box:', err);
			}
			break;
		case 'optimizeQueryOptions':
			try {
				const boxId = message.boxId || '';
				const models = message.models || [];
				const selectedModelId = message.selectedModelId || '';
				const promptText = message.promptText || '';
				if (typeof __kustoApplyOptimizeQueryOptions === 'function') {
					__kustoApplyOptimizeQueryOptions(boxId, models, selectedModelId, promptText);
				}
			} catch { /* ignore */ }
			break;
		case 'optimizeQueryError':
			try {
				const boxId = message.boxId || '';
				try {
					if (typeof __kustoSetOptimizeInProgress === 'function') {
						__kustoSetOptimizeInProgress(boxId, false, '');
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoHideOptimizePromptForBox === 'function') {
						__kustoHideOptimizePromptForBox(boxId);
					}
				} catch { /* ignore */ }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQueryOptions':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotApplyWriteQueryOptions === 'function') {
					window.__kustoCopilotApplyWriteQueryOptions(
						boxId,
						message.models || [],
						message.selectedModelId || '',
						message.tools || []
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQueryStatus':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotWriteQueryStatus === 'function') {
					window.__kustoCopilotWriteQueryStatus(boxId, message.status || '');
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQuerySetQuery':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotWriteQuerySetQuery === 'function') {
					window.__kustoCopilotWriteQuerySetQuery(boxId, message.query || '');
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQueryExecuting':
			try {
				const boxId = String(message.boxId || '');
				const executing = !!message.executing;
				if (boxId && typeof setQueryExecuting === 'function') {
					setQueryExecuting(boxId, executing);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQueryToolResult':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotWriteQueryToolResult === 'function') {
					window.__kustoCopilotWriteQueryToolResult(
						boxId,
						message.tool || '',
						message.label || '',
						message.json || '',
						message.entryId || ''
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotExecutedQuery':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotAppendExecutedQuery === 'function') {
					window.__kustoCopilotAppendExecutedQuery(
						boxId,
						message.query || '',
						message.resultSummary || '',
						message.errorMessage || '',
						message.entryId || '',
						message.result || null // Pass result for insert-with-results
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotGeneralQueryRulesLoaded':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotAppendGeneralRulesLink === 'function') {
					window.__kustoCopilotAppendGeneralRulesLink(
						boxId,
						message.filePath || '',
						message.preview || '',
						message.entryId || ''
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotUserQuerySnapshot':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotAppendQuerySnapshot === 'function') {
					window.__kustoCopilotAppendQuerySnapshot(
						boxId,
						message.queryText || '',
						message.entryId || ''
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotClarifyingQuestion':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotAppendClarifyingQuestion === 'function') {
					window.__kustoCopilotAppendClarifyingQuestion(
						boxId,
						message.question || '',
						message.entryId || ''
					);
				}
			} catch { /* ignore */ }
			break;
		case 'copilotWriteQueryDone':
			try {
				const boxId = String(message.boxId || '');
				if (boxId && typeof window.__kustoCopilotWriteQueryDone === 'function') {
					window.__kustoCopilotWriteQueryDone(boxId, !!message.ok, message.message || '');
				}
			} catch { /* ignore */ }
			break;
		case 'copilotInlineCompletionResult':
			console.log('[Kusto] Received copilotInlineCompletionResult', message);
			try {
				const requestId = String(message.requestId || '');
				console.log('[Kusto] Looking for pending request', requestId, 'in', Object.keys(copilotInlineCompletionRequests));
				if (requestId && copilotInlineCompletionRequests[requestId]) {
					const pending = copilotInlineCompletionRequests[requestId];
					delete copilotInlineCompletionRequests[requestId];
					if (typeof pending.resolve === 'function') {
						console.log('[Kusto] Resolving with completions:', message.completions);
						pending.resolve(message.completions || []);
					}
				} else {
					console.log('[Kusto] No pending request found for', requestId);
				}
			} catch (err) { console.error('[Kusto] Error handling completion result', err); }
			break;
		
		// ─────────────────────────────────────────────────────────────────────────
		// VS Code Copilot Chat Tool Orchestrator Messages
		// ─────────────────────────────────────────────────────────────────────────
		
		case 'requestToolState':
			// Extension is requesting the current sections state
			try {
				const requestId = String(message.requestId || '');
				if (requestId && typeof getKqlxState === 'function') {
					const state = getKqlxState();
					const sections = (state && state.sections) ? state.sections : [];
					vscode.postMessage({ type: 'toolStateResponse', requestId, sections });
				}
			} catch (err) {
				console.error('[Kusto Tools] Error getting state:', err);
				try {
					vscode.postMessage({ type: 'toolStateResponse', requestId: message.requestId, sections: [] });
				} catch { /* ignore */ }
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
						if (typeof addQueryBox === 'function') {
							sectionId = addQueryBox();
							success = !!sectionId;
							// Set initial values if provided
							if (sectionId && input.query) {
								const editor = queryEditors && queryEditors[sectionId];
								if (editor && typeof editor.setValue === 'function') {
									editor.setValue(String(input.query));
								}
							}
							if (sectionId && input.clusterUrl) {
								// Find connection by cluster URL
								const conn = (connections || []).find(c => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
								if (conn) {
									const select = document.getElementById(sectionId + '_connection');
									if (select) {
										select.value = conn.id;
										select.dispatchEvent(new Event('change'));
									}
								}
							}
							if (sectionId && input.database) {
								const dbSelect = document.getElementById(sectionId + '_database');
								if (dbSelect) {
									dbSelect.value = input.database;
									dbSelect.dispatchEvent(new Event('change'));
								}
							}
						}
					} else if (sectionType === 'markdown') {
						if (typeof addMarkdownBox === 'function') {
							// Pass text as option so it's available when the editor initializes
							const markdownOptions = input.text ? { text: String(input.text) } : undefined;
							sectionId = addMarkdownBox(markdownOptions);
							success = !!sectionId;
						}
					} else if (sectionType === 'chart') {
						if (typeof addChartBox === 'function') {
							sectionId = addChartBox();
							success = !!sectionId;
						}
					} else if (sectionType === 'transformation') {
						if (typeof addTransformationBox === 'function') {
							sectionId = addTransformationBox();
							success = !!sectionId;
						}
					} else if (sectionType === 'url') {
						if (typeof addUrlBox === 'function') {
							sectionId = addUrlBox();
							success = !!sectionId;
						}
					} else if (sectionType === 'python') {
						if (typeof addPythonBox === 'function') {
							sectionId = addPythonBox();
							success = !!sectionId;
						}
					}
				} catch (err) {
					console.error('[Kusto Tools] Error adding section:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { sectionId, success }, error: success ? undefined : 'Failed to add section' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				console.error('[Kusto Tools] Error in toolAddSection:', err);
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolRemoveSection':
			// Remove a section by ID
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				
				try {
					const sectionEl = document.getElementById(sectionId);
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
				} catch (err) {
					console.error('[Kusto Tools] Error removing section:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Section not found' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
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
						const contentEl = document.getElementById(sectionId + '_content');
						if (contentEl) {
							contentEl.style.display = collapsed ? 'none' : '';
							success = true;
						}
					}
				} catch (err) {
					console.error('[Kusto Tools] Error collapsing section:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to collapse/expand section' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
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
					
					// Update query text
					if (input.query !== undefined && editor && typeof editor.setValue === 'function') {
						editor.setValue(String(input.query));
						success = true;
					}
					
					// Update cluster
					if (input.clusterUrl) {
						const conn = (connections || []).find(c => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
						if (conn) {
							const select = document.getElementById(sectionId + '_connection');
							if (select) {
								select.value = conn.id;
								select.dispatchEvent(new Event('change'));
								success = true;
							}
						} else {
							// Connection not found - return error with available connections
							const availableConnections = (connections || []).map(c => c && c.clusterUrl ? String(c.clusterUrl) : '').filter(Boolean);
							vscode.postMessage({ 
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
							await new Promise(r => setTimeout(r, 500));
						}
						const dbSelect = document.getElementById(sectionId + '_database');
						if (dbSelect) {
							// Check if database exists in the dropdown
							let found = false;
							for (let i = 0; i < dbSelect.options.length; i++) {
								if (dbSelect.options[i].value === input.database) {
									found = true;
									break;
								}
							}
							if (found) {
								dbSelect.value = input.database;
								dbSelect.dispatchEvent(new Event('change'));
								success = true;
							} else {
								// Database not found - return available databases
								const availableDatabases = [];
								for (let i = 0; i < dbSelect.options.length; i++) {
									if (dbSelect.options[i].value) availableDatabases.push(dbSelect.options[i].value);
								}
								vscode.postMessage({ 
									type: 'toolResponse', 
									requestId, 
									result: { 
										success: false, 
										error: `Database "${input.database}" not found on this cluster.`,
										availableDatabases,
										fix: 'Use #listKustoSchemas with the clusterUrl to see available databases.'
									}
								});
								return;
							}
						}
					}
					
					// Execute if requested
					if (input.execute && typeof executeQuery === 'function') {
						executeQuery(sectionId);
					}
				} catch (err) {
					console.error('[Kusto Tools] Error configuring query section:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { success, resultPreview }, error: success ? undefined : 'Failed to configure query section' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolExecuteQuery':
			// Execute a query and return results preview
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				
				// Set up a one-time listener for the result
				const resultHandler = (resultEvent) => {
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
							} catch { /* ignore */ }
							
							vscode.postMessage({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: true, rowCount, columns, resultPreview: preview }
							});
						} else if (resultMsg && resultMsg.type === 'queryError' && resultMsg.boxId === sectionId) {
							window.removeEventListener('message', resultHandler);
							vscode.postMessage({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: false, error: resultMsg.error || 'Query execution failed' }
							});
						}
					} catch { /* ignore */ }
				};
				
				window.addEventListener('message', resultHandler);
				
				// Set timeout to clean up listener
				setTimeout(() => {
					window.removeEventListener('message', resultHandler);
				}, 120000); // 2 minute timeout
				
				if (typeof executeQuery === 'function') {
					executeQuery(sectionId);
				} else {
					window.removeEventListener('message', resultHandler);
					vscode.postMessage({ type: 'toolResponse', requestId, result: { success: false }, error: 'executeQuery not available' });
				}
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
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
					if (input.text !== undefined) {
						const textToSet = String(input.text);
						window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
						window.__kustoPendingMarkdownTextByBoxId[sectionId] = textToSet;
						
						// Try to update existing editor (exposed on window from extraBoxes.js)
						const editorInstance = window.__kustoMarkdownEditors && window.__kustoMarkdownEditors[sectionId];
						if (editorInstance && typeof editorInstance.setMarkdown === 'function') {
							editorInstance.setMarkdown(textToSet);
							success = true;
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
				} catch (err) {
					console.error('[Kusto Tools] Error updating markdown section:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to update markdown section' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureChart':
			// Configure a chart section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				let validationStatus = null;
				
				try {
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
					if (typeof window.__kustoGetChartValidationStatus === 'function') {
						validationStatus = window.__kustoGetChartValidationStatus(sectionId);
					}
				} catch (err) {
					console.error('[Kusto Tools] Error configuring chart:', err);
				}
				
				// Include validation status in response so agent can verify configuration worked
				const result = { success, ...( validationStatus ? { validation: validationStatus } : {}) };
				vscode.postMessage({ type: 'toolResponse', requestId, result, error: success ? undefined : 'Failed to configure chart' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
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
				} catch (err) {
					console.error('[Kusto Tools] Error configuring transformation:', err);
				}
				
				vscode.postMessage({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to configure transformation' });
				try { if (typeof schedulePersist === 'function') schedulePersist(); } catch { /* ignore */ }
			} catch (err) {
				vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
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
						} else if (typeof addQueryBox === 'function') {
							sectionId = addQueryBox();
						}
					}
					
					if (!sectionId) {
						vscode.postMessage({ type: 'toolResponse', requestId, result: { success: false, error: 'No query section available' } });
						return;
					}
					
					// VALIDATE: Check that connection and database are configured on this section
					const connectionDropdown = document.getElementById(sectionId + '_connection');
					const databaseDropdown = document.getElementById(sectionId + '_database');
					const currentConnectionId = connectionDropdown ? String(connectionDropdown.value || '') : '';
					const currentDatabase = databaseDropdown ? String(databaseDropdown.value || '') : '';
					
					// Get cluster URL for context
					let currentClusterUrl = '';
					try {
						if (currentConnectionId && Array.isArray(connections)) {
							const conn = connections.find(c => c && String(c.id || '') === currentConnectionId);
							currentClusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch { /* ignore */ }
					
					if (!currentConnectionId) {
						vscode.postMessage({ 
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
						vscode.postMessage({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: `Query section is connected to cluster${currentClusterUrl ? ` (${currentClusterUrl})` : ''} but no database is selected.`,
								sectionId,
								clusterUrl: currentClusterUrl || undefined,
								fix: 'Use #configureKustoQuerySection to set the database. You can use #listKustoSchemas with the clusterUrl to see available databases.'
							}
						});
						return;
					}
				
				// Step 1: Show the Copilot Chat panel (toggle the button)
				if (typeof window.__kustoSetCopilotChatVisible === 'function') {
					window.__kustoSetCopilotChatVisible(sectionId, true);
				} else if (typeof window.__kustoToggleCopilotChatForBox === 'function') {
					// Check if already visible, if not toggle
					const isVisible = typeof window.__kustoGetCopilotChatVisible === 'function' 
						? window.__kustoGetCopilotChatVisible(sectionId) 
						: false;
					if (!isVisible) {
						window.__kustoToggleCopilotChatForBox(sectionId);
					}
				}
				
				// Give the UI a moment to render
				await new Promise(r => setTimeout(r, 100));
				
				// Step 2: Paste the question into the chat input
				const chatInput = document.getElementById(sectionId + '_copilot_input');
				if (!chatInput) {
					vscode.postMessage({ type: 'toolResponse', requestId, result: { success: false, error: 'Copilot chat input not found. Is Copilot available?' } });
					return;
				}
				chatInput.value = question;
				chatInput.dispatchEvent(new Event('input', { bubbles: true }));
				
				// Set up listener for results BEFORE clicking send
				let responded = false;
				let generatedQuery = '';
				let queryGenerated = false;
				let pendingQueryResult = null; // Store queryResult if it arrives before copilotWriteQueryDone
				
				// Helper to send successful response
				const sendSuccessResponse = (msg) => {
					if (responded) return;
					responded = true;
					window.removeEventListener('message', resultHandler);
					
					// Get current query from editor
					try {
						const editor = queryEditors && queryEditors[sectionId];
						if (editor && typeof editor.getValue === 'function') {
							generatedQuery = editor.getValue() || generatedQuery;
						}
					} catch { /* ignore */ }
					
					// Clear the Copilot chat "thinking..." state
					try {
						if (typeof window.__kustoCopilotWriteQueryDone === 'function') {
							window.__kustoCopilotWriteQueryDone(sectionId, true, '');
						}
					} catch { /* ignore */ }
					
					// Get the results
					let rows = [];
					let columns = [];
					let rowCount = 0;
					
					// Try to get from the result state (most reliable after display)
					try {
						if (typeof __kustoGetResultsState === 'function') {
							const resultState = __kustoGetResultsState(sectionId);
							if (resultState) {
								columns = Array.isArray(resultState.columns) ? resultState.columns : [];
								rows = Array.isArray(resultState.rows) ? resultState.rows : [];
								rowCount = rows.length;
							}
						}
					} catch { /* ignore */ }
					
					// Fallback to message data
					if (columns.length === 0 && msg && msg.result && msg.result.primaryResults && msg.result.primaryResults.length > 0) {
						const primary = msg.result.primaryResults[0];
						columns = primary.columns ? primary.columns.map(c => c.name || c) : [];
						rows = primary.rows || [];
						rowCount = rows.length;
					}
					
					// Limit rows for response size
					const truncated = rows.length > 100;
					if (truncated) {
						rows = rows.slice(0, 100);
					}
					
					vscode.postMessage({ 
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
				
				const resultHandler = (event) => {
					try {
						const msg = event && event.data;
						if (!msg || responded) return;
						
						// Copilot finished generating/writing query
						if (msg.type === 'copilotWriteQueryDone' && msg.boxId === sectionId) {
							queryGenerated = true;
							try {
								const editor = queryEditors && queryEditors[sectionId];
								generatedQuery = editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
							} catch { /* ignore */ }
							
							if (!msg.ok) {
								responded = true;
								window.removeEventListener('message', resultHandler);
								
								// Clear the Copilot chat "thinking..." state
								try {
									if (typeof window.__kustoCopilotWriteQueryDone === 'function') {
										window.__kustoCopilotWriteQueryDone(sectionId, false, msg.message || '');
									}
								} catch { /* ignore */ }
								
								vscode.postMessage({ 
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
							
							// Clear the Copilot chat "thinking..." state
							try {
								if (typeof window.__kustoCopilotWriteQueryDone === 'function') {
									window.__kustoCopilotWriteQueryDone(sectionId, false, msg.error || 'Query execution failed');
								}
							} catch { /* ignore */ }
							
							vscode.postMessage({ 
								type: 'toolResponse', 
								requestId, 
								result: { 
									success: false,
									query: generatedQuery || undefined,
									error: msg.error || 'Query execution failed'
								}
							});
						}
					} catch (err) {
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
						try {
							if (typeof window.__kustoCopilotWriteQueryDone === 'function') {
								window.__kustoCopilotWriteQueryDone(sectionId, false, 'Request timed out');
							}
						} catch { /* ignore */ }
						
						vscode.postMessage({ 
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
				const sendButton = document.getElementById(sectionId + '_copilot_send');
				if (sendButton && !sendButton.disabled) {
					sendButton.click();
				} else if (typeof window.__kustoCopilotWriteQuerySend === 'function') {
					// Fallback: call the send function directly
					window.__kustoCopilotWriteQuerySend(sectionId);
				} else {
					// Clean up and report error
					clearTimeout(timeoutId);
					window.removeEventListener('message', resultHandler);
					vscode.postMessage({ type: 'toolResponse', requestId, result: { success: false, error: 'Could not find send button or send function' } });
				}
				
				} catch (err) {
					console.error('[Kusto Tools] Error delegating to Copilot:', err);
					vscode.postMessage({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
	}
});

// Request connections on load
vscode.postMessage({ type: 'getConnections' });
// Global Copilot capability check (for add-controls Copilot button)
try { vscode.postMessage({ type: 'checkCopilotAvailability', boxId: '__kusto_global__' }); } catch { /* ignore */ }
// Request document state on load (.kqlx custom editor)
try { vscode.postMessage({ type: 'requestDocument' }); } catch { /* ignore */ }

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
		} catch {
			// ignore
		}

		let draggingId = '';
		let draggingOriginalNextSibling = null;
		let draggingDidDrop = false;
		let globalDnDGuardsInstalled = false;

		// While reordering, prevent the browser (and editors like Monaco) from treating this as a text drop.
		// Without this, dropping over an input/textarea/editor surface can insert the drag payload and create
		// a real edit, which then correctly leaves the document dirty.
		const ensureGlobalDnDGuards = () => {
			if (globalDnDGuardsInstalled) return;
			globalDnDGuardsInstalled = true;
			try {
					const isInContainer = (eventTarget) => {
						try {
							return !!(container && eventTarget && container.contains && container.contains(eventTarget));
						} catch {
							return false;
						}
					};
					document.addEventListener('dragenter', (e) => {
						if (!draggingId) return;
						try { e.preventDefault(); } catch { /* ignore */ }
						// Only suppress drag events outside the container, so live reordering still works.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch { /* ignore */ }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch { /* ignore */ }
					}, true);
				document.addEventListener('dragover', (e) => {
					if (!draggingId) return;
					try { e.preventDefault(); } catch { /* ignore */ }
						// Allow container dragover to run so we can live-reorder.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch { /* ignore */ }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch { /* ignore */ }
				}, true);
				document.addEventListener('drop', (e) => {
					if (!draggingId) return;
						// If the drop is inside the container, let the container's drop handler finish the reorder.
						if (isInContainer(e.target)) return;
						try { e.preventDefault(); } catch { /* ignore */ }
						try { e.stopPropagation(); } catch { /* ignore */ }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch { /* ignore */ }
				}, true);
			} catch { /* ignore */ }
		};

		const resyncArraysFromDom = () => {
			try {
				const ids = Array.from(container.children || [])
					.map((el) => (el && el.id ? String(el.id) : ''))
					.filter(Boolean);
				try { if (typeof queryBoxes !== 'undefined') queryBoxes = ids.filter((id) => id.startsWith('query_')); } catch { /* ignore */ }
				try { if (typeof markdownBoxes !== 'undefined') markdownBoxes = ids.filter((id) => id.startsWith('markdown_')); } catch { /* ignore */ }
				try { if (typeof pythonBoxes !== 'undefined') pythonBoxes = ids.filter((id) => id.startsWith('python_')); } catch { /* ignore */ }
				try { if (typeof urlBoxes !== 'undefined') urlBoxes = ids.filter((id) => id.startsWith('url_')); } catch { /* ignore */ }
			} catch {
				// ignore
			}
		};

		const bestEffortRelayoutMovedEditors = (boxId) => {
			try {
				const q = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[boxId] : null;
				const md = (typeof markdownEditors !== 'undefined' && markdownEditors) ? markdownEditors[boxId] : null;
				const py = (typeof pythonEditors !== 'undefined' && pythonEditors) ? pythonEditors[boxId] : null;
				const editors = [q, md, py].filter(Boolean);
				if (!editors.length) return;
				setTimeout(() => {
					for (const ed of editors) {
						try { if (ed && typeof ed.layout === 'function') ed.layout(); } catch { /* ignore */ }
					}
				}, 0);
			} catch {
				// ignore
			}
		};

		container.addEventListener('dragstart', (e) => {
			ensureGlobalDnDGuards();
			try {
				// Only allow reordering in .kqlx mode.
				if (window.__kustoCompatibilityMode) {
					try { e.preventDefault(); } catch { /* ignore */ }
					try { e.stopPropagation(); } catch { /* ignore */ }
					return;
				}
			} catch {
				// ignore
			}

			const handle = e && e.target && e.target.closest ? e.target.closest('.section-drag-handle') : null;
			if (!handle) {
				return;
			}
			const box = handle.closest ? handle.closest('.query-box') : null;
			if (!box || !box.id) {
				return;
			}
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
					try { e.dataTransfer.setData('text/plain', ''); } catch { /* ignore */ }
					try { e.dataTransfer.setData('application/x-kusto-section-reorder', draggingId); } catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
		});

		container.addEventListener('dragover', (e) => {
			if (!draggingId) {
				return;
			}
			try {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
			} catch {
				// ignore
			}

			// Live reorder as the mouse moves.
			try {
				const dragged = document.getElementById(draggingId);
				if (!dragged) return;
				const y = typeof e.clientY === 'number' ? e.clientY : null;
				if (y === null) return;
				const boxes = Array.from(container.children || [])
					.filter((el) => el && el.classList && el.classList.contains('query-box') && el !== dragged);
				if (boxes.length === 0) return;

				let insertBeforeEl = null;
				for (const box of boxes) {
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
			} catch {
				// ignore
			}
		});

		container.addEventListener('drop', (e) => {
			if (!draggingId) {
				return;
			}
			try { e.preventDefault(); } catch { /* ignore */ }
			draggingDidDrop = true;
			const dragged = document.getElementById(draggingId);
			if (!dragged) {
				draggingId = '';
				return;
			}

			// Compute insertion point based on the drop Y position.
			// This is much more reliable when dropping in whitespace above the first or below the last section.
			try {
				const dropY = typeof e.clientY === 'number' ? e.clientY : null;
				const boxes = Array.from(container.children || [])
					.filter((el) => el && el.classList && el.classList.contains('query-box') && el !== dragged);

				if (boxes.length === 0) {
					container.appendChild(dragged);
				} else if (dropY === null) {
					container.appendChild(dragged);
				} else {
					let inserted = false;
					for (const box of boxes) {
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
				try { container.appendChild(dragged); } catch { /* ignore */ }
			}

			resyncArraysFromDom();
			bestEffortRelayoutMovedEditors(draggingId);
			try { schedulePersist && schedulePersist('reorder'); } catch { /* ignore */ }
			// Refresh Data dropdowns in Chart/Transformation sections to update position labels
			try { window.__kustoRefreshAllDataSourceDropdowns && window.__kustoRefreshAllDataSourceDropdowns(); } catch { /* ignore */ }
			draggingId = '';
			draggingOriginalNextSibling = null;
		});

		container.addEventListener('dragend', () => {
			try {
				if (draggingId && !draggingDidDrop) {
					const dragged = document.getElementById(draggingId);
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
						try { schedulePersist && schedulePersist('reorder'); } catch { /* ignore */ }
						// Refresh Data dropdowns in Chart/Transformation sections to update position labels
						try { window.__kustoRefreshAllDataSourceDropdowns && window.__kustoRefreshAllDataSourceDropdowns(); } catch { /* ignore */ }
					}
				}
			} catch {
				// ignore
			}
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
// See queryEditor.css for the @container rules that handle:
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
function __kustoToggleAddSectionDropdown(event) {
	try {
		if (event) {
			event.stopPropagation();
		}
		const btn = document.getElementById('addSectionDropdownBtn');
		const menu = document.getElementById('addSectionDropdownMenu');
		if (!btn || !menu) return;

		const wasOpen = menu.style.display === 'block';

		// Close all other dropdowns first.
		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.closeAllMenus === 'function') {
				window.__kustoDropdown.closeAllMenus();
			}
		} catch { /* ignore */ }

		if (wasOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
			return;
		}

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');

		// Apply visibility based on allowed section kinds.
		__kustoUpdateAddSectionDropdownVisibility();

	} catch { /* ignore */ }
}

// Called when a dropdown item is selected.
function __kustoAddSectionFromDropdown(kind) {
	try {
		// Close the dropdown.
		const btn = document.getElementById('addSectionDropdownBtn');
		const menu = document.getElementById('addSectionDropdownMenu');
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');

		// Add the section.
		if (typeof __kustoRequestAddSection === 'function') {
			__kustoRequestAddSection(kind);
		}
	} catch { /* ignore */ }
}

// Update dropdown item visibility based on allowed section kinds (mirrors __kustoApplyDocumentCapabilities logic).
function __kustoUpdateAddSectionDropdownVisibility() {
	try {
		const allowed = Array.isArray(window.__kustoAllowedSectionKinds)
			? window.__kustoAllowedSectionKinds.map(v => String(v))
			: ['query', 'chart', 'transformation', 'markdown', 'python', 'url'];

		const items = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of items) {
			const kind = item.getAttribute('data-add-kind');
			if (allowed.length === 0 || allowed.includes(kind)) {
				item.style.display = '';
			} else {
				item.style.display = 'none';
			}
		}
	} catch { /* ignore */ }
}

// Close dropdown when clicking outside.
document.addEventListener('click', (event) => {
	try {
		const menu = document.getElementById('addSectionDropdownMenu');
		const btn = document.getElementById('addSectionDropdownBtn');
		if (!menu || menu.style.display !== 'block') return;

		const target = event.target;
		if (target && typeof target.closest === 'function') {
			if (target.closest('.add-controls-dropdown')) {
				return; // Click inside dropdown, don't close.
			}
		}

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch { /* ignore */ }
});

// Close dropdown on Escape key.
document.addEventListener('keydown', (event) => {
	try {
		if (event.key !== 'Escape') return;
		const menu = document.getElementById('addSectionDropdownMenu');
		const btn = document.getElementById('addSectionDropdownBtn');
		if (!menu || menu.style.display !== 'block') return;

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch { /* ignore */ }
});
