function isDarkTheme() {
	// VS Code webviews typically toggle these classes on theme changes.
	try {
		const cls = document && document.body && document.body.classList;
		if (cls) {
			if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) {
				return false;
			}
			if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) {
				return true;
			}
		}
	} catch {
		// ignore
	}

	const parseCssColorToRgb = (value) => {
		const v = String(value || '').trim();
		if (!v) {
			return null;
		}
		// rgb()/rgba()
		let m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+)\s*)?\)/i);
		if (m) {
			return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
		}
		// #RGB, #RRGGBB, #RRGGBBAA
		m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (m) {
			const hex = m[1];
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return { r, g, b };
			}
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return { r, g, b };
		}
		return null;
	};

	let bg = '';
	try {
		bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
	} catch {
		bg = '';
	}
	const rgb = parseCssColorToRgb(bg);
	if (!rgb) {
		// Fall back to dark if we can't determine; better than flashing light.
		return true;
	}
	const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
	return luminance < 0.5;
}

let monacoThemeObserverStarted = false;
let lastAppliedIsDarkTheme = null;

function applyMonacoTheme(monaco) {
	if (!monaco || !monaco.editor || typeof monaco.editor.setTheme !== 'function') {
		return;
	}
	let dark = true;
	try {
		dark = isDarkTheme();
	} catch {
		dark = true;
	}
	if (lastAppliedIsDarkTheme === dark) {
		return;
	}
	lastAppliedIsDarkTheme = dark;
	try {
		monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
	} catch {
		// ignore
	}
}

function startMonacoThemeObserver(monaco) {
	if (monacoThemeObserverStarted) {
		return;
	}
	monacoThemeObserverStarted = true;

	// Apply once now (safe even if ensureMonaco already set theme).
	applyMonacoTheme(monaco);

	let pending = false;
	const schedule = () => {
		if (pending) {
			return;
		}
		pending = true;
		setTimeout(() => {
			pending = false;
			applyMonacoTheme(monaco);
		}, 0);
	};

	try {
		const observer = new MutationObserver(() => schedule());
		if (document && document.body) {
			observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document && document.documentElement) {
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	} catch {
		// ignore
	}
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

					const KUSTO_KEYWORD_DOCS = {
						'summarize': {
							signature: '| summarize [Column =] Aggregation(...) [by GroupKey[, ...]]',
							description: 'Aggregates rows into groups (optionally) and computes aggregate values.'
						},
						'where': {
							signature: '| where Predicate',
							description: 'Filters rows using a boolean predicate.'
						},
						'extend': {
							signature: '| extend Column = Expression[, ...]',
							description: 'Adds calculated columns to the result set.'
						},
						'project': {
							signature: '| project Column[, ...]',
							description: 'Selects and optionally renames columns.'
						},
						'join': {
							signature: '| join kind=... (RightTable) on Key',
							description: 'Combines rows from two tables using a matching key.'
						},
						'take': {
							signature: '| take N',
							description: 'Returns up to N rows.'
						},
						'top': {
							signature: '| top N by Expression [desc|asc]',
							description: 'Returns the top N rows ordered by an expression.'
						},
						'render': {
							signature: '| render VisualizationType',
							description: 'Renders results using a chart/visualization type.'
						},
						'mv-expand': {
							signature: '| mv-expand Column',
							description: 'Expands multi-value (array/dynamic) into multiple rows.'
						}
					};

					const KUSTO_FUNCTION_DOCS = {
						'dcountif': {
							args: ['expr', 'predicate', 'accuracy?'],
							returnType: 'long',
							description: 'Returns the number of distinct values of expr for which predicate evaluates to true.'
						},
						'countif': {
							args: ['predicate'],
							returnType: 'long',
							description: 'Counts rows for which predicate evaluates to true.'
						},
						'sumif': {
							args: ['expr', 'predicate'],
							returnType: 'real',
							description: 'Sums expr over rows where predicate is true.'
						},
						'avgif': {
							args: ['expr', 'predicate'],
							returnType: 'real',
							description: 'Averages expr over rows where predicate is true.'
						}
					};

					const isIdentChar = (ch) => /[A-Za-z0-9_]/.test(ch);
					const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);

					const getWordRangeAt = (model, position) => {
						try {
							const w = model.getWordAtPosition(position);
							if (!w) {
								return null;
							}
							return new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
						} catch {
							return null;
						}
					};

					const findEnclosingFunctionCall = (model, offset) => {
						const text = model.getValue();
						if (!text) {
							return null;
						}

						let depth = 0;
						let inSingle = false;
						for (let i = offset - 1; i >= 0; i--) {
							const ch = text[i];
							if (ch === "'") {
								// Toggle string if not escaped.
								const prev = i > 0 ? text[i - 1] : '';
								if (prev !== '\\') {
									inSingle = !inSingle;
								}
								continue;
							}
							if (inSingle) {
								continue;
							}
							if (ch === ')') {
								depth++;
								continue;
							}
							if (ch === '(') {
								if (depth === 0) {
									// Found the opening paren for the call containing the cursor.
									let j = i - 1;
									while (j >= 0 && /\s/.test(text[j])) j--;
									let end = j;
									while (j >= 0 && isIdentChar(text[j])) j--;
									const start = j + 1;
									if (start <= end && isIdentStart(text[start])) {
										const name = text.slice(start, end + 1);
										return { name, openParenOffset: i, nameStart: start, nameEnd: end + 1 };
									}
									return null;
								}
								depth--;
							}
						}
						return null;
					};

					const computeArgIndex = (model, openParenOffset, offset) => {
						const text = model.getValue();
						let idx = 0;
						let depth = 0;
						let inSingle = false;
						for (let i = openParenOffset + 1; i < offset && i < text.length; i++) {
							const ch = text[i];
							if (ch === "'") {
								const prev = i > 0 ? text[i - 1] : '';
								if (prev !== '\\') {
									inSingle = !inSingle;
								}
								continue;
							}
							if (inSingle) continue;
							if (ch === '(') {
								depth++;
								continue;
							}
							if (ch === ')') {
								if (depth > 0) depth--;
								continue;
							}
							if (depth === 0 && ch === ',') {
								idx++;
							}
						}
						return idx;
					};

					const buildFunctionSignatureMarkdown = (name, doc, activeArgIndex) => {
						const args = Array.isArray(doc.args) ? doc.args : [];
						const formattedArgs = args.map((a, i) => (i === activeArgIndex ? `**${a}**` : a)).join(', ');
						const ret = doc.returnType ? `: ${doc.returnType}` : '';
						return `\`${name}(${formattedArgs})${ret}\``;
					};

					const getHoverInfoAt = (model, position) => {
						let offset;
						try {
							offset = model.getOffsetAt(position);
						} catch {
							return null;
						}

						// Prefer function-call context (cursor could be inside args).
						// Note: when the caret is on '(' (or just before it), the backward scan starting at offset-1
						// may miss the opening paren. Probe slightly forward so active-arg tracking works while typing.
						let call = findEnclosingFunctionCall(model, offset);
						let callOffset = offset;
						if (!call) {
							try {
								const text = model.getValue();
								if (text && offset < text.length) {
									call = findEnclosingFunctionCall(model, offset + 1);
									callOffset = offset + 1;
								}
								if (!call && text && (offset + 1) < text.length) {
									call = findEnclosingFunctionCall(model, offset + 2);
									callOffset = offset + 2;
								}
							} catch {
								// ignore
							}
						}
						if (call) {
							const fnKey = String(call.name || '').toLowerCase();
							const doc = KUSTO_FUNCTION_DOCS[fnKey];
							if (doc) {
								let argIndex = computeArgIndex(model, call.openParenOffset, callOffset);
								try {
									const args = Array.isArray(doc.args) ? doc.args : [];
									if (args.length > 0 && typeof argIndex === 'number') {
										argIndex = Math.max(0, Math.min(argIndex, args.length - 1));
									}
								} catch {
									// ignore
								}
								const md =
									buildFunctionSignatureMarkdown(fnKey, doc, argIndex) +
									(doc.description ? `\n\n${doc.description}` : '');
								const startPos = model.getPositionAt(call.nameStart);
								const endPos = model.getPositionAt(call.nameEnd);
								const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
								return { range, markdown: md };
							}
						}

						// Otherwise, show keyword/function docs for the word under cursor.
						let word = null;
						try {
							word = model.getWordAtPosition(position);
						} catch {
							word = null;
						}
						if (!word || !word.word) {
							return null;
						}
						const w = String(word.word).toLowerCase();
						if (KUSTO_FUNCTION_DOCS[w]) {
							const doc = KUSTO_FUNCTION_DOCS[w];
							const md =
								buildFunctionSignatureMarkdown(w, doc, -1) +
								(doc.description ? `\n\n${doc.description}` : '');
							return { range: getWordRangeAt(model, position), markdown: md };
						}
						if (KUSTO_KEYWORD_DOCS[w]) {
							const doc = KUSTO_KEYWORD_DOCS[w];
							const md = `\`${doc.signature}\`\n\n${doc.description || ''}`.trim();
							return { range: getWordRangeAt(model, position), markdown: md };
						}

						return null;
					};
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

					// Basic formatter so users can format the whole query.
					const formatKusto = (input) => {
						const raw = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						const lines = raw.split('\n');
						const out = [];
						let blankRun = 0;
						for (let line of lines) {
							line = String(line).replace(/[ \t]+$/g, '');
							if (!line.trim()) {
								blankRun++;
								if (blankRun <= 2) {
									out.push('');
								}
								continue;
							}
							blankRun = 0;
							// Normalize leading whitespace.
							line = line.replace(/^\s+/g, '');
							// Normalize pipe operator lines: "| foo".
							if (/^\|/.test(line)) {
								line = '| ' + line.slice(1).replace(/^\s+/g, '');
							}
							out.push(line);
						}
						// Trim leading/trailing blank lines.
						while (out.length && !out[0].trim()) out.shift();
						while (out.length && !out[out.length - 1].trim()) out.pop();
						return out.join('\n');
					};

					monaco.languages.registerDocumentFormattingEditProvider('kusto', {
						provideDocumentFormattingEdits(model) {
							try {
								const original = model.getValue();
								const formatted = formatKusto(original);
								if (formatted === original) {
									return [];
								}
								return [{ range: model.getFullModelRange(), text: formatted }];
							} catch {
								return [];
							}
						}
					});

					monaco.editor.setTheme(isDarkTheme() ? 'vs-dark' : 'vs');
					startMonacoThemeObserver(monaco);

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

						// Hover docs for keywords/functions, including argument tracking for function calls.
						monaco.languages.registerHoverProvider('kusto', {
							provideHover: function (model, position) {
								try {
									const info = getHoverInfoAt(model, position);
									if (!info) {
										return null;
									}
									return {
										range: info.range || undefined,
										contents: [{ value: info.markdown }]
									};
								} catch {
									return null;
								}
							}
						});

						// Expose a helper so the editor instance can decide whether to auto-show hover.
						window.__kustoGetHoverInfoAt = getHoverInfoAt;
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

		// Apply any pending restored text (restore runs before Monaco is ready).
		try {
			const pending = window.__kustoPendingQueryTextByBoxId && window.__kustoPendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				const prevRestore = (typeof __kustoRestoreInProgress === 'boolean') ? __kustoRestoreInProgress : false;
				try {
					__kustoRestoreInProgress = true;
					editor.setValue(pending);
				} finally {
					__kustoRestoreInProgress = prevRestore;
				}
				try { delete window.__kustoPendingQueryTextByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		queryEditors[boxId] = editor;

		// F1 should show docs hover (not the webview / VS Code default behavior).
		try {
			editor.addCommand(monaco.KeyCode.F1, () => {
				try {
					editor.trigger('keyboard', 'editor.action.showHover', {});
				} catch {
					// ignore
				}
			});
		} catch {
			// ignore
		}

		// Docs tooltip: keep visible while typing, even when Monaco autocomplete is open.
		const renderDocMarkdownToHtml = (markdown) => {
			const raw = String(markdown || '');
			if (!raw.trim()) {
				return '';
			}
			const escaped = typeof escapeHtml === 'function' ? escapeHtml(raw) : raw;
			return escaped
				.replace(/\r\n/g, '\n')
				.replace(/\n\n/g, '<br><br>')
				.replace(/\n/g, '<br>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Show literal **...** markers while also bolding the content.
				.replace(/\*\*([^*]+)\*\*/g, '<strong>**$1**</strong>');
		};

		// Use a DOM overlay (instead of Monaco content widgets) for reliability in VS Code webviews.
		const createDocOverlay = () => {
			const dom = document.createElement('div');
			dom.className = 'kusto-doc-widget kusto-doc-widget-overlay';
			dom.style.display = 'none';
			// Use fixed positioning so the tooltip can render outside the editor bounds.
			dom.style.position = 'fixed';
			dom.style.zIndex = '2000';
			dom.style.left = '0px';
			dom.style.top = '0px';
			let lastHtml = '';
			let lastKey = '';
			try {
				(document.body || document.documentElement).appendChild(dom);
			} catch {
				// ignore
			}

			const hide = () => {
				dom.style.display = 'none';
			};

			const update = () => {
				try {
					if (!caretDocsEnabled) {
						hide();
						return;
					}
					const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
					const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
					const isThisEditorActive = (activeQueryEditorBoxId === boxId) || hasWidgetFocus || hasTextFocus;
					if (!isThisEditorActive) {
						hide();
						return;
					}
					const model = editor.getModel();
					const pos = editor.getPosition();
					const sel = editor.getSelection();
					if (!model || !pos || !sel || !sel.isEmpty()) {
						hide();
						return;
					}
					// If the caret is after a closing ')' (even with trailing whitespace), stop showing the custom tooltip.
					try {
						const fullText = model.getValue();
						const caretOffset = model.getOffsetAt(pos);
						let i = Math.min(Math.max(0, caretOffset - 1), fullText.length - 1);
						while (i >= 0 && /\s/.test(fullText[i])) i--;
						if (i >= 0 && fullText[i] === ')') {
							hide();
							return;
						}
					} catch {
						// ignore
					}
					const coords = typeof editor.getScrolledVisiblePosition === 'function' ? editor.getScrolledVisiblePosition(pos) : null;
					if (!coords) {
						hide();
						return;
					}
					const getter = window.__kustoGetHoverInfoAt;
					if (typeof getter !== 'function') {
						hide();
						return;
					}
					// Probe near the caret so we still show docs when the caret is on/near '(' or ')' or just after ')'.
					// Keep the caret position first so active-argument detection stays accurate.
					const probePositions = [pos];
					try {
						const maxCol = typeof model.getLineMaxColumn === 'function' ? model.getLineMaxColumn(pos.lineNumber) : null;
						if (pos.column > 1) probePositions.push(new monaco.Position(pos.lineNumber, pos.column - 1));
						if (pos.column > 2) probePositions.push(new monaco.Position(pos.lineNumber, pos.column - 2));
						if (typeof maxCol === 'number' && pos.column < maxCol) probePositions.push(new monaco.Position(pos.lineNumber, pos.column + 1));
					} catch {
						// ignore
					}
					let info = null;
					for (const p of probePositions) {
						try {
							info = getter(model, p);
							if (info && info.markdown) break;
						} catch {
							// ignore
						}
					}
					const html = info && info.markdown ? renderDocMarkdownToHtml(info.markdown) : '';
					if (!html) {
						hide();
						return;
					}

					const key = `${pos.lineNumber}:${pos.column}:${html.slice(0, 120)}`;
					if (html !== lastHtml) {
						lastHtml = html;
						dom.innerHTML = html;
					}
					if (key !== lastKey) {
						lastKey = key;
					}

					dom.style.display = 'block';

					const editorDom = editor.getDomNode();
					if (!editorDom) {
						return;
					}
					const editorRect = editorDom.getBoundingClientRect();

					// Caret in viewport coordinates.
					const caretX = editorRect.left + coords.left;
					const caretHeight = coords.height || 16;
					const cursorY = editorRect.top + coords.top + caretHeight;

					const margin = 6;
					const clearance = 14; // keep tooltip bottom above the typing cursor (but not too high)
					const width = dom.offsetWidth;
					const height = dom.offsetHeight;

					// Prefer above cursor; allow outside editor bounds; clamp to viewport.
					let left = caretX;
					let top = cursorY - height - margin - clearance;

					const viewportMargin = 6;
					const maxLeft = Math.max(viewportMargin, window.innerWidth - width - viewportMargin);
					left = Math.min(Math.max(viewportMargin, left), maxLeft);
					const maxTop = Math.max(viewportMargin, window.innerHeight - height - viewportMargin);
					top = Math.min(Math.max(viewportMargin, top), maxTop);

					dom.style.left = `${Math.round(left)}px`;
					dom.style.top = `${Math.round(top)}px`;
				} catch {
					// ignore
				}
			};

			return { update, hide };
		};

		const docOverlay = createDocOverlay();
		try { caretDocOverlaysByBoxId[boxId] = docOverlay; } catch { /* ignore */ }

		// Hide caret tooltip on Escape (without preventing Monaco default behavior).
		try {
			editor.onKeyDown((e) => {
				try {
					if (!e) return;
					// monaco.KeyCode.Escape === 9
					if (e.keyCode === monaco.KeyCode.Escape) {
						try { docOverlay.hide(); } catch { /* ignore */ }
					}
				} catch {
					// ignore
				}
			});
		} catch {
			// ignore
		}
		let docTimer = null;
		const scheduleDocUpdate = () => {
			try {
				if (docTimer) {
					clearTimeout(docTimer);
				}
				docTimer = setTimeout(() => {
					try { docOverlay.update(); } catch { /* ignore */ }
				}, 140);
			} catch {
				// ignore
			}
		};

		editor.onDidChangeCursorPosition(scheduleDocUpdate);
		try { editor.onDidScrollChange(scheduleDocUpdate); } catch { /* ignore */ }
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
		editor.onDidChangeModelContent(() => {
			syncPlaceholder();
			scheduleDocUpdate();
			try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		});
		editor.onDidFocusEditorText(() => {
			activeQueryEditorBoxId = boxId;
			syncPlaceholder();
			ensureSchemaForBox(boxId);
			scheduleDocUpdate();
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				activeQueryEditorBoxId = boxId;
				syncPlaceholder();
				scheduleDocUpdate();
			});
			editor.onDidBlurEditorWidget(() => {
				try { docOverlay.hide(); } catch { /* ignore */ }
				if (activeQueryEditorBoxId === boxId) {
					activeQueryEditorBoxId = null;
				}
				syncPlaceholder();
			});
		} catch {
			// ignore
		}

		// In VS Code webviews, the first click can sometimes focus the webview but not reliably
		// place the Monaco caret if we eagerly call editor.focus() during the same mouse event.
		// Defer focus slightly so Monaco can handle click-to-place-caret on the first click.
		const focusSoon = () => {
			setTimeout(() => {
				try { activeQueryEditorBoxId = boxId; } catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, 0);
		};
		const isEditorFocused = () => {
			try {
				const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
				const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
				return hasWidgetFocus || hasTextFocus;
			} catch {
				return false;
			}
		};

		if (wrapper) {
			wrapper.addEventListener('mousedown', (e) => {
				try {
					if (e && e.target && e.target.closest) {
						if (e.target.closest('.query-editor-toolbar')) {
							return;
						}
						if (e.target.closest('.query-editor-resizer')) {
							return;
						}
					}
				} catch {
					// ignore
				}
				focusSoon();
			}, true);
		}

		// Keep a direct hook on the editor container too.
		container.addEventListener('mousedown', () => {
			focusSoon();
		}, true);
		editor.onDidBlurEditorText(() => {
			syncPlaceholder();
		});

		// Ensure Monaco has a correct initial layout after insertion into the DOM.
		try {
			requestAnimationFrame(() => {
				try { editor.layout(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

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
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	});
}
