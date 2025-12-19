// VS Code can intercept Ctrl/Cmd+V in webviews; provide a reliable paste path for Monaco.
document.addEventListener('keydown', async (event) => {
	if (!(event.ctrlKey || event.metaKey) || (event.key !== 'v' && event.key !== 'V')) {
		return;
	}

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

	if (!editor) {
		return;
	}

	try {
		const text = await navigator.clipboard.readText();
		if (typeof text !== 'string') {
			return;
		}
		event.preventDefault();
		const selection = editor.getSelection();
		if (selection) {
			editor.executeEdits('clipboard', [{ range: selection, text }]);
			editor.focus();
		}
	} catch (e) {
		// If clipboard read isn't permitted, fall back to default behavior.
		// (Do not preventDefault in this case.)
	}
}, true);

// Close open modal dialogs on Escape.
// Only intercept Escape when a modal is visible, so we don't interfere with
// Monaco/editor keybindings during normal editing.
document.addEventListener('keydown', (event) => {
	try {
		if (!event || event.key !== 'Escape') {
			return;
		}

		let handled = false;

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
	if (event.key === 'x' || event.key === 'X') {
		void __kustoCopyOrCutFocusedMonaco(event, true);
		return;
	}
	if (event.key === 'c' || event.key === 'C') {
		void __kustoCopyOrCutFocusedMonaco(event, false);
		return;
	}
}, true);

// Right-click context menu Cut/Copy often routes through these events.
document.addEventListener('cut', (event) => {
	void __kustoCopyOrCutFocusedMonaco(event, true);
}, true);
document.addEventListener('copy', (event) => {
	void __kustoCopyOrCutFocusedMonaco(event, false);
}, true);

// Ctrl+Enter (Cmd+Enter on macOS) runs the active query box, same as clicking the main run button.
document.addEventListener('keydown', (event) => {
	if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') {
		return;
	}
	if (!activeQueryEditorBoxId) {
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

window.addEventListener('message', event => {
	const message = (event && event.data && typeof event.data === 'object') ? event.data : {};
	const messageType = String(message.type || '');
	switch (messageType) {
		case 'controlCommandSyntaxResult':
			try {
				const commandLower = message && typeof message.commandLower === 'string' ? String(message.commandLower) : '';
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
		case 'connectionsData':
			connections = message.connections;
			lastConnectionId = message.lastConnectionId;
			lastDatabase = message.lastDatabase;
			cachedDatabases = message.cachedDatabases || {};
			kustoFavorites = Array.isArray(message.favorites) ? message.favorites : [];
			caretDocsEnabled = (typeof message.caretDocsEnabled === 'boolean') ? message.caretDocsEnabled : true;
			try {
				// Indicates whether the user has explicitly chosen a value (on/off) before.
				// When true, document-level restore should not override this global preference.
				window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet;
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

			updateDatabaseSelect(message.boxId, message.databases);
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
					onDatabasesError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.');
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
					alert('No connections found in the selected XML file.');
					break;
				}
				vscode.postMessage({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });
			} catch (e) {
				alert('Failed to import connections: ' + (e && e.message ? e.message : String(e)));
			}
			break;
		case 'importConnectionsXmlError':
			alert('Failed to import connections: ' + (message && message.error ? String(message.error) : 'Unknown error'));
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
				if (typeof displayResult === 'function') {
					displayResult(message.result);
				} else if (typeof window.displayResult === 'function') {
					window.displayResult(message.result);
				} else if (message.boxId && typeof displayResultForBox === 'function') {
					displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
				} else if (message.boxId && typeof window.displayResultForBox === 'function') {
					window.displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
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
			schemaByBoxId[message.boxId] = message.schema;
			setSchemaLoading(message.boxId, false);
			try {
				if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
					window.__kustoScheduleKustoDiagnostics(message.boxId, 0);
				}
			} catch { /* ignore */ }
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				setSchemaLoadedSummary(
					message.boxId,
					tablesCount + ' tables, ' + columnsCount + ' cols',
					'Schema loaded for autocomplete' + (meta.fromCache ? ' (cached)' : ''),
					false,
					{ fromCache: !!meta.fromCache, tablesCount, columnsCount }
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
				const queryName = message.queryName || '';
				const connectionId = message.connectionId || '';
				const database = message.database || '';
				let prettifiedOptimizedQuery = optimizedQuery;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						prettifiedOptimizedQuery = window.__kustoPrettifyKustoText(optimizedQuery);
					}
				} catch { /* ignore */ }
				
				// Check if a comparison box was already created for this source
				if (optimizationMetadataByBoxId[sourceBoxId] && optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId) {
					console.log('Comparison box already exists for source box:', sourceBoxId);
					// Just restore the button state
					const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn');
					if (optimizeBtn) {
						optimizeBtn.disabled = false;
						if (optimizeBtn.dataset.originalContent) {
							optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
							delete optimizeBtn.dataset.originalContent;
						}
					}
					return;
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
					comparisonNameInput.value = queryName + ' (Optimized)';
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
						message.json || ''
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
