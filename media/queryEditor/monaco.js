function isDarkTheme() {
	const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
	const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
	if (!match) {
		return true;
	}
	const r = parseInt(match[1], 10);
	const g = parseInt(match[2], 10);
	const b = parseInt(match[3], 10);
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return luminance < 0.5;
}

function ensureMonaco() {
	if (monacoReadyPromise) {
		return monacoReadyPromise;
	}

	monacoReadyPromise = new Promise((resolve, reject) => {
		try {
			// Monaco worker bootstrap
			window.MonacoEnvironment = {
				getWorkerUrl: function () {
					return window.__kustoQueryEditorConfig.monacoVsUri + '/base/worker/workerMain.js';
				}
			};

			require.config({ paths: { vs: window.__kustoQueryEditorConfig.monacoVsUri } });
			require(['vs/editor/editor.main'], () => {
				try {
					monaco.languages.register({ id: 'kusto' });
					monaco.languages.setMonarchTokensProvider('kusto', {
						keywords: [
							'and', 'as', 'by', 'case', 'contains', 'count', 'dcount', 'distinct', 'extend', 'externaldata',
							'false', 'from', 'has', 'has_any', 'has_all', 'in', 'invoke', 'join', 'kind', 'let', 'limit',
							'mv-expand', 'not', 'null', 'on', 'or', 'order', 'project', 'project-away', 'project-keep',
							'project-rename', 'render', 'sample', 'search', 'serialize', 'sort', 'summarize', 'take',
							'top', 'toscalar', 'true', 'union', 'where'
						],
						tokenizer: {
							root: [
								[/\/\*.*?\*\//, 'comment'],
								[/\/\/.*$/, 'comment'],
								[/'.*?'/, 'string'],
								[/\b\d+(\.\d+)?\b/, 'number'],
								[/\|/, 'delimiter'],
								[/[=><!~]+/, 'operator'],
								[/[a-zA-Z_][\w\-]*/, {
									cases: {
										'@keywords': 'keyword',
										'@default': 'identifier'
									}
								}],
								[/[{}()\[\]]/, '@brackets'],
								[/[,;.]/, 'delimiter']
							]
						}
					});
					monaco.languages.setLanguageConfiguration('kusto', {
						comments: { lineComment: '//', blockComment: ['/*', '*/'] },
						brackets: [['{', '}'], ['[', ']'], ['(', ')']],
						autoClosingPairs: [
							{ open: '{', close: '}' },
							{ open: '[', close: ']' },
							{ open: '(', close: ')' },
							{ open: "'", close: "'" }
						]
					});

					monaco.editor.setTheme(isDarkTheme() ? 'vs-dark' : 'vs');

					// Autocomplete driven by cached schema (tables + columns).
					monaco.languages.registerCompletionItemProvider('kusto', {
						triggerCharacters: [' ', '|', '.'],
						provideCompletionItems: function (model, position) {
							let boxId = null;
							try {
								if (model && model.uri) {
									boxId = queryEditorBoxByModelUri[model.uri.toString()] || null;
								}
							} catch {
								// ignore
							}
							if (!boxId) {
								boxId = activeQueryEditorBoxId;
							}
							const schema = boxId ? schemaByBoxId[boxId] : null;
							if (!schema || !schema.tables) {
								// Kick off a background fetch if schema isn't ready yet.
								ensureSchemaForBox(boxId);
								return { suggestions: [] };
							}

							const word = model.getWordUntilPosition(position);
							const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
							const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1).toLowerCase();
							const shouldSuggestColumns = /\|\s*(project|where|extend|summarize|order\s+by|sort\s+by|take|top)\b[^|]*$/i.test(linePrefix);

							const textUpToCursor = model.getValueInRange({
								startLineNumber: 1,
								startColumn: 1,
								endLineNumber: position.lineNumber,
								endColumn: position.column
							});

							const inferActiveTable = (text) => {
								// Prefer last explicit join/from target.
								const joinFromMatches = Array.from(text.matchAll(/\b(join|from)\s+([A-Za-z_][\w-]*)\b/gi));
								if (joinFromMatches.length > 0) {
									return joinFromMatches[joinFromMatches.length - 1][2];
								}

								// Otherwise, find the first "source" line (not a pipe/operator line).
								const lines = text.split(/\r?\n/);
								for (const raw of lines) {
									const line = raw.trim();
									if (!line) {
										continue;
									}
									if (line.startsWith('|') || line.startsWith('.') || line.startsWith('//')) {
										continue;
									}
									const m = line.match(/^([A-Za-z_][\w-]*)\b/);
									if (m) {
										return m[1];
									}
								}
								return null;
							};

							let activeTable = inferActiveTable(textUpToCursor);

							const suggestions = [];
							const seen = new Set();

							const pushSuggestion = (item, key) => {
								const k = key || item.label;
								if (seen.has(k)) {
									return;
								}
								seen.add(k);
								suggestions.push(item);
							};

							// Columns first when in '| where' / '| project' etc.
							if (shouldSuggestColumns) {
								let columns = null;
								if (activeTable && schema.columnsByTable && schema.columnsByTable[activeTable]) {
									columns = schema.columnsByTable[activeTable];
								} else if (schema.tables && schema.tables.length === 1 && schema.columnsByTable && schema.columnsByTable[schema.tables[0]]) {
									activeTable = schema.tables[0];
									columns = schema.columnsByTable[activeTable];
								} else if (schema.columnsByTable) {
									// Fallback: suggest the union of columns across tables (deduped).
									const set = new Set();
									for (const cols of Object.values(schema.columnsByTable)) {
										for (const c of cols) set.add(c);
									}
									columns = Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 500);
								}

								if (columns) {
									for (const c of columns) {
										pushSuggestion({
											label: c,
											kind: monaco.languages.CompletionItemKind.Field,
											insertText: c,
											sortText: '0' + c,
											range
										}, 'col:' + c);
									}
								}
							}

							// Tables: always suggest.
							for (const t of schema.tables) {
								pushSuggestion({
									label: t,
									kind: monaco.languages.CompletionItemKind.Class,
									insertText: t,
									sortText: (shouldSuggestColumns ? '1' : '0') + t,
									range
								}, 'tbl:' + t);
							}

							return { suggestions };
						}
					});
					resolve(monaco);
				} catch (e) {
					reject(e);
				}
			});
		} catch (e) {
			reject(e);
		}
	});

	return monacoReadyPromise;
}

function initQueryEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_query_editor');
		const wrapper = container ? container.parentElement : null;
		const placeholder = document.getElementById(boxId + '_query_placeholder');
		const resizer = document.getElementById(boxId + '_query_resizer');
		if (!container) {
			return;
		}

		// Ensure flex sizing doesn't allow the editor container to expand with content.
		container.style.minHeight = '0';
		container.style.minWidth = '0';

		const editor = monaco.editor.create(container, {
			value: '',
			language: 'kusto',
			readOnly: false,
			automaticLayout: true,
			suggestOnTriggerCharacters: true,
			quickSuggestions: { other: true, comments: false, strings: false },
			quickSuggestionsDelay: 200,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		queryEditors[boxId] = editor;
		try {
			const model = editor.getModel();
			if (model && model.uri) {
				queryEditorBoxByModelUri[model.uri.toString()] = boxId;
			}
		} catch {
			// ignore
		}

		const syncPlaceholder = () => {
			if (!placeholder) {
				return;
			}
			// Hide placeholder while the editor is focused, even if empty.
			const isFocused = activeQueryEditorBoxId === boxId;
			placeholder.style.display = (!editor.getValue().trim() && !isFocused) ? 'block' : 'none';
		};
		syncPlaceholder();
		editor.onDidChangeModelContent(syncPlaceholder);
		editor.onDidFocusEditorText(() => {
			activeQueryEditorBoxId = boxId;
			syncPlaceholder();
			ensureSchemaForBox(boxId);
		});
		container.addEventListener('mousedown', () => editor.focus());
		editor.onDidBlurEditorText(() => {
			if (activeQueryEditorBoxId === boxId) {
				activeQueryEditorBoxId = null;
			}
			syncPlaceholder();
		});

		// Auto-trigger suggestions while typing once schema is loaded.
		editor.onDidChangeModelContent(() => {
			if (!schemaByBoxId[boxId]) {
				return;
			}
			if (suggestDebounceTimers[boxId]) {
				clearTimeout(suggestDebounceTimers[boxId]);
			}
			suggestDebounceTimers[boxId] = setTimeout(() => {
				try {
					editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
				} catch {
					// ignore
				}
			}, 180);
		});

		// Keep Monaco laid out when the user resizes the wrapper.
		if (wrapper && typeof ResizeObserver !== 'undefined') {
			if (queryEditorResizeObservers[boxId]) {
				try { queryEditorResizeObservers[boxId].disconnect(); } catch { /* ignore */ }
			}
			const ro = new ResizeObserver(() => {
				try { editor.layout(); } catch { /* ignore */ }
			});
			ro.observe(wrapper);
			queryEditorResizeObservers[boxId] = ro;
		}

		// Drag handle resize (more reliable than CSS resize in VS Code webviews).
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startY = e.clientY;
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					const delta = moveEvent.clientY - startY;
					const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
					try { editor.layout(); } catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	});
}
