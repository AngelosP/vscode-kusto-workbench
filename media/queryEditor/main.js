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
});

// Request connections on load
vscode.postMessage({ type: 'getConnections' });
// Request document state on load (.kqlx custom editor)
try { vscode.postMessage({ type: 'requestDocument' }); } catch { /* ignore */ }

window.addEventListener('message', event => {
	const message = event.data;
	switch (message.type) {
			case 'persistenceMode':
				try {
					window.__kustoIsSessionFile = !!message.isSessionFile;
				} catch {
					// ignore
				}
				break;
		case 'connectionsData':
			connections = message.connections;
			lastConnectionId = message.lastConnectionId;
			lastDatabase = message.lastDatabase;
			cachedDatabases = message.cachedDatabases || {};
			caretDocsEnabled = (typeof message.caretDocsEnabled === 'boolean') ? message.caretDocsEnabled : true;
			updateConnectionSelects();
			try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
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
		case 'databasesData':
			updateDatabaseSelect(message.boxId, message.databases);
			break;
		case 'queryResult':
			try {
				if (message.boxId) {
					window.lastExecutedBox = message.boxId;
				}
			} catch {
				// ignore
			}
			displayResult(message.result);
			break;
		case 'queryError':
			try {
				if (message.boxId) {
					window.lastExecutedBox = message.boxId;
				}
			} catch {
				// ignore
			}
			displayError(message.error);
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
			schemaByBoxId[message.boxId] = message.schema;
			setSchemaLoading(message.boxId, false);
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const cacheTag = meta.fromCache ? ' (cache)' : '';
				setSchemaLoadedSummary(
					message.boxId,
					'Schema: ' + tablesCount + ' tables, ' + columnsCount + ' cols' + cacheTag,
					'Schema loaded for autocomplete' + cacheTag,
					false
				);
			}
			break;
		case 'schemaError':
			// Non-fatal; autocomplete will just not have schema.
			setSchemaLoading(message.boxId, false);
			setSchemaLoadedSummary(message.boxId, 'Schema failed', message.error || 'Schema fetch failed', true);
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
	}
});

// Initial content is now driven by the .kqlx document state.
