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
						if (typeof __kustoSetCompatibilityMode === 'function') {
							__kustoSetCompatibilityMode(!!message.compatibilityMode);
						} else {
							window.__kustoCompatibilityMode = !!message.compatibilityMode;
						}
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
			try {
				// Indicates whether the user has explicitly chosen a value (on/off) before.
				// When true, document-level restore should not override this global preference.
				window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet;
			} catch { /* ignore */ }
			updateConnectionSelects();
			try {
				if (typeof window.__kustoOnConnectionsUpdated === 'function') {
					window.__kustoOnConnectionsUpdated();
				}
			} catch { /* ignore */ }
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
							cachedDatabases[cid] = list;
						}
					} catch { /* ignore */ }
					try { r.resolve(list); } catch { /* ignore */ }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }

			updateDatabaseSelect(message.boxId, message.databases);
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
			displayResult(message.result);
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
			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message.error || 'Schema fetch failed')); } catch { /* ignore */ }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch { /* ignore */ }
					break;
				}
			} catch { /* ignore */ }
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
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
				if (optimizeBtn) {
					if (!available) {
						optimizeBtn.disabled = true;
						optimizeBtn.title = 'Optimize query performance\n\nGitHub Copilot is required for this feature. Enable Copilot in VS Code to use query optimization.';
					} else {
						optimizeBtn.disabled = false;
						optimizeBtn.title = 'Optimize query performance';
					}
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
	}
});

// Initial content is now driven by the .kqlx document state.
