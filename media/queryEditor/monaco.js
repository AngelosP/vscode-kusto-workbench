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

	const waitForAmdLoader = () => {
		return new Promise((resolve, reject) => {
			let attempts = 0;
			const tick = () => {
				attempts++;
				try {
					const req = (typeof require !== 'undefined') ? require : (window && window.require ? window.require : undefined);
					if (typeof req === 'function' && typeof req.config === 'function') {
						resolve(req);
						return;
					}
				} catch {
					// ignore
				}
				if (attempts >= 60) {
					reject(new Error('Monaco AMD loader (require.js) not available in webview.'));
					return;
				}
				setTimeout(tick, 50);
			};
			tick();
		});
	};

	monacoReadyPromise = new Promise((resolve, reject) => {
		try {
			waitForAmdLoader().then((req) => {
				// Monaco worker bootstrap.
				// Monaco 0.5x uses version-hashed worker assets under vs/assets. The extension host
				// discovers them and passes them into __kustoQueryEditorConfig.monacoWorkers.
				try {
					const cfg = window && window.__kustoQueryEditorConfig ? window.__kustoQueryEditorConfig : {};
					const workers = cfg && cfg.monacoWorkers ? cfg.monacoWorkers : null;
					const cacheBuster = cfg && cfg.cacheBuster ? String(cfg.cacheBuster) : '';

					const withCache = (url) => {
						try {
							if (!cacheBuster) return String(url);
							const u = new URL(String(url));
							u.searchParams.set('v', cacheBuster);
							return u.toString();
						} catch {
							return String(url);
						}
					};

					if (workers && (workers.editor || workers.ts || workers.json || workers.css || workers.html)) {
						window.MonacoEnvironment = window.MonacoEnvironment || {};
						window.MonacoEnvironment.getWorker = function (_moduleId, label) {
							const l = String(label || '').toLowerCase();
							let key = 'editor';
							if (l === 'json') key = 'json';
							else if (l === 'css' || l === 'scss' || l === 'less') key = 'css';
							else if (l === 'html' || l === 'handlebars' || l === 'razor') key = 'html';
							else if (l === 'typescript' || l === 'javascript') key = 'ts';

							const url = workers[key] || workers.editor;
							if (!url) {
								throw new Error('Monaco worker asset URL not available for label: ' + label);
							}
							const workerUrl = withCache(url);

							// VS Code webviews can fail to construct a Worker directly from a vscode-webview:// URL
							// (depending on Chromium/webview security restrictions). A common workaround is to
							// create a Blob worker that importScripts() the actual worker URL.
							try {
								return new Worker(workerUrl);
							} catch {
								// ignore and fall back
							}

							try {
								const blobSource = `/* Monaco Worker Wrapper */\nimportScripts(${JSON.stringify(workerUrl)});`;
								const blob = new Blob([blobSource], { type: 'text/javascript' });
								const blobUrl = URL.createObjectURL(blob);
								const w = new Worker(blobUrl);
								// Best-effort cleanup: revoke once the worker has had a chance to start.
								setTimeout(() => {
									try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
								}, 30_000);
								return w;
							} catch (e) {
								// If even the Blob worker fails, rethrow so Monaco can fall back to main thread.
								throw e;
							}
						};
					}
				} catch {
					// ignore
				}

				try {
					req.config({ paths: { vs: window.__kustoQueryEditorConfig.monacoVsUri } });
				} catch (e) {
					reject(e);
					return;
				}

				req(
					['vs/editor.api.001a2486'],
					() => {
						try {
							if (typeof monaco === 'undefined' || !monaco || !monaco.editor) {
								throw new Error('Monaco loaded but global `monaco` API is missing.');
							}
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
						},
						'distinct': {
							signature: '| distinct Column[, ...]',
							description: 'Returns unique combinations of the specified columns.'
						},
						'limit': {
							signature: '| limit N',
							description: 'Returns up to N rows (alias of take in many contexts).'
						},
						'sample': {
							signature: '| sample N',
							description: 'Returns N random rows from the input.'
						},
						'union': {
							signature: '| union Table[, ...]',
							description: 'Combines results from multiple tables or subqueries.'
						},
						'search': {
							signature: '| search "text"',
							description: 'Searches for a term across columns (and optionally tables) in scope.'
						},
						'project-away': {
							signature: '| project-away Column[, ...]',
							description: 'Removes columns from the result set.'
						},
						'project-keep': {
							signature: '| project-keep Column[, ...]',
							description: 'Keeps only the specified columns (dropping others).'
						},
						'project-rename': {
							signature: '| project-rename NewName = OldName[, ...]',
							description: 'Renames columns.'
						},
						'order by': {
							signature: '| order by Expression [asc|desc][, ...]',
							description: 'Sorts rows by one or more expressions.'
						},
						'sort by': {
							signature: '| sort by Expression [asc|desc][, ...]',
							description: 'Sorts rows by one or more expressions (alias of order by).'
						}
					};

					const KUSTO_PIPE_OPERATOR_SUGGESTIONS = [
						{ label: 'where', insert: 'where ', docKey: 'where' },
						{ label: 'extend', insert: 'extend ', docKey: 'extend' },
						{ label: 'project', insert: 'project ', docKey: 'project' },
						{ label: 'project-away', insert: 'project-away ', docKey: 'project-away' },
						{ label: 'project-keep', insert: 'project-keep ', docKey: 'project-keep' },
						{ label: 'project-rename', insert: 'project-rename ', docKey: 'project-rename' },
						{ label: 'summarize', insert: 'summarize ', docKey: 'summarize' },
						{ label: 'join', insert: 'join ', docKey: 'join' },
						{ label: 'distinct', insert: 'distinct ', docKey: 'distinct' },
						{ label: 'take', insert: 'take ', docKey: 'take' },
						{ label: 'limit', insert: 'limit ', docKey: 'limit' },
						{ label: 'top', insert: 'top ', docKey: 'top' },
						{ label: 'order by', insert: 'order by ', docKey: 'order by' },
						{ label: 'sort by', insert: 'sort by ', docKey: 'sort by' },
						{ label: 'render', insert: 'render ', docKey: 'render' },
						{ label: 'mv-expand', insert: 'mv-expand ', docKey: 'mv-expand' }
					];

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

					const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
					const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);

					const getTokenAtPosition = (model, position) => {
						try {
							const lineNumber = position.lineNumber;
							const line = model.getLineContent(lineNumber);
							if (!line) {
								return null;
							}
							// Monaco columns are 1-based; convert to 0-based index into the line string.
							let idx = Math.min(Math.max(0, position.column - 1), line.length);
							// If we're at end-of-line or on a non-word char, probe one character to the left.
							if (idx > 0 && (idx === line.length || !isIdentChar(line[idx]))) {
								idx = idx - 1;
							}
							if (idx < 0 || idx >= line.length || !isIdentChar(line[idx])) {
								return null;
							}
							let start = idx;
							while (start > 0 && isIdentChar(line[start - 1])) start--;
							let end = idx + 1;
							while (end < line.length && isIdentChar(line[end])) end++;
							const word = line.slice(start, end);
							if (!word) {
								return null;
							}
							const range = new monaco.Range(lineNumber, start + 1, lineNumber, end + 1);
							return { word, range };
						} catch {
							return null;
						}
					};

					const getMultiWordOperatorAt = (model, position) => {
						try {
							const lineNumber = position.lineNumber;
							const line = model.getLineContent(lineNumber);
							const col = position.column;
							if (!line) return null;

							const checks = [
								{ key: 'order by', re: /\border\s+by\b/ig },
								{ key: 'sort by', re: /\bsort\s+by\b/ig }
							];

							for (const chk of checks) {
								chk.re.lastIndex = 0;
								let m;
								while ((m = chk.re.exec(line)) !== null) {
									const startCol = m.index + 1;
									const endCol = m.index + m[0].length + 1;
									if (col >= startCol && col <= endCol) {
										return { key: chk.key, range: new monaco.Range(lineNumber, startCol, lineNumber, endCol) };
									}
								}
							}

							return null;
						} catch {
							return null;
						}
					};

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

						// Otherwise, show keyword/function docs for the token under cursor.
						// Handle multi-word operators like "order by" / "sort by".
						const multi = getMultiWordOperatorAt(model, position);
						if (multi && multi.key && KUSTO_KEYWORD_DOCS[multi.key]) {
							const doc = KUSTO_KEYWORD_DOCS[multi.key];
							const md = `\`${doc.signature}\`\n\n${doc.description || ''}`.trim();
							return { range: multi.range, markdown: md };
						}

						const token = getTokenAtPosition(model, position);
						if (!token || !token.word) {
							return null;
						}
						const w = String(token.word).toLowerCase();
						if (KUSTO_FUNCTION_DOCS[w]) {
							const doc = KUSTO_FUNCTION_DOCS[w];
							const md =
								buildFunctionSignatureMarkdown(w, doc, -1) +
								(doc.description ? `\n\n${doc.description}` : '');
							return { range: token.range || getWordRangeAt(model, position), markdown: md };
						}
						if (KUSTO_KEYWORD_DOCS[w]) {
							const doc = KUSTO_KEYWORD_DOCS[w];
							const md = `\`${doc.signature}\`\n\n${doc.description || ''}`.trim();
							return { range: token.range || getWordRangeAt(model, position), markdown: md };
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

					// Autocomplete: pipe operators + (optionally) schema tables/columns.
					monaco.languages.registerCompletionItemProvider('kusto', {
						triggerCharacters: [' ', '|', '.'],
						provideCompletionItems: function (model, position) {
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

							const lineContent = model.getLineContent(position.lineNumber);
							const linePrefixRaw = lineContent.slice(0, position.column - 1);
							const linePrefix = linePrefixRaw.toLowerCase();

							// Prefer a range that includes '-' so mv-expand/project-away suggestions replace the whole token.
							let replaceRange = null;
							try {
								const token = getTokenAtPosition(model, position);
								replaceRange = token && token.range ? token.range : null;
							} catch {
								replaceRange = null;
							}
							if (!replaceRange) {
								const word = model.getWordUntilPosition(position);
								replaceRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
							}

							const isAfterPipe = /\|\s*[A-Za-z_\-]*$/i.test(linePrefixRaw) && /\|/i.test(linePrefixRaw);
							if (isAfterPipe) {
								for (const op of KUSTO_PIPE_OPERATOR_SUGGESTIONS) {
									pushSuggestion({
										label: op.label,
										kind: monaco.languages.CompletionItemKind.Keyword,
										insertText: op.insert,
										sortText: '0_' + op.label,
										range: replaceRange
									}, 'op:' + op.label);
								}
							}

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
								// Kick off a background fetch if schema isn't ready yet (but still return operator suggestions).
								ensureSchemaForBox(boxId);
								return { suggestions };
							}

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


							// For schema completions, use Monaco's default word range (tables/columns rarely include '-').
							const word = model.getWordUntilPosition(position);
							const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

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
					},
					(e) => reject(e)
				);
			}).catch((e) => reject(e));
		} catch (e) {
			reject(e);
		}
	});

	// If Monaco init fails, allow retries within the same webview session.
	monacoReadyPromise = monacoReadyPromise.catch((e) => {
		try { monacoReadyPromise = null; } catch { /* ignore */ }
		throw e;
	});

	return monacoReadyPromise;
}

// Proactively start loading Monaco as soon as this script is loaded.
// This reduces the time the UI appears as a non-interactive placeholder before the editor mounts.
try {
	setTimeout(() => {
		try {
			const p = ensureMonaco();
			if (p && typeof p.catch === 'function') {
				p.catch(() => { /* ignore */ });
			}
		} catch {
			// ignore
		}
	}, 0);
} catch {
	// ignore
}

// Auto-resize Monaco editor wrappers so the full content is visible (no inner scrollbars).
// This only applies while the wrapper has NOT been manually resized by the user.
// User resize is tracked via wrapper.dataset.kustoUserResized === 'true'.
function __kustoAttachAutoResizeToContent(editor, containerEl) {
	try {
		if (!editor || !containerEl || !containerEl.closest) {
			return;
		}
		const wrapper = containerEl.closest('.query-editor-wrapper');
		if (!wrapper) {
			return;
		}

		const apply = () => {
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					return;
				}
				// If this wrapper is in markdown preview mode, the editor is hidden and wrapper is auto.
				try {
					const box = wrapper.closest ? wrapper.closest('.query-box') : null;
					if (box && box.classList && box.classList.contains('is-md-preview')) {
						return;
					}
				} catch {
					// ignore
				}

				const contentHeight = (typeof editor.getContentHeight === 'function') ? editor.getContentHeight() : 0;
				if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) {
					return;
				}

				// Wrapper total = fixed chrome (toolbars/resizers) + Monaco content height.
				let chrome = 0;
				try {
					for (const child of Array.from(wrapper.children || [])) {
						if (!child || !child.classList) continue;
						if (child.classList.contains('query-editor')) continue;
						chrome += (child.getBoundingClientRect ? child.getBoundingClientRect().height : 0);
					}
				} catch {
					// ignore
				}

				const next = Math.max(120, Math.ceil(chrome + contentHeight));
				wrapper.style.height = next + 'px';
				try {
					// Ensure Monaco re-layouts after the container changes.
					editor.layout();
				} catch {
					// ignore
				}
			} catch {
				// ignore
			}
		};

		// Apply once soon, and then on every content size change.
		try {
			requestAnimationFrame(() => apply());
		} catch {
			setTimeout(() => apply(), 0);
		}
		try {
			if (typeof editor.onDidContentSizeChange === 'function') {
				editor.onDidContentSizeChange(() => apply());
			}
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

// VS Code webviews occasionally open in a state where Monaco's hidden textarea ends up readonly/disabled
// due to focus/timing glitches. This helper aggressively forces the editor back into writable mode.
const __kustoWritableGuardsByEditor = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;


function __kustoNormalizeTextareasWritable(root) {
	try {
		if (!root || typeof root.querySelectorAll !== 'function') {
			return;
		}
		const textareas = root.querySelectorAll('textarea');
		if (!textareas || !textareas.length) {
			return;
		}
		for (const ta of textareas) {
			if (!ta) continue;
			try { ta.readOnly = false; } catch { /* ignore */ }
			try { ta.disabled = false; } catch { /* ignore */ }
			try { ta.removeAttribute && ta.removeAttribute('readonly'); } catch { /* ignore */ }
			try { ta.removeAttribute && ta.removeAttribute('disabled'); } catch { /* ignore */ }
			// Some environments can set aria-disabled; clear it to avoid AT/DOM locking.
			try { ta.removeAttribute && ta.removeAttribute('aria-disabled'); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function __kustoForceEditorWritable(editor) {
	try {
		if (!editor) return;
		try {
			if (typeof editor.updateOptions === 'function') {
				editor.updateOptions({ readOnly: false, domReadOnly: false });
			}
		} catch {
			// ignore
		}
		try {
			const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
			if (!dom) return;
			// Monaco can have multiple textareas (inputarea, find widget, etc.).
			// Ensure none of them are stuck readonly/disabled.
			__kustoNormalizeTextareasWritable(dom);
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

function __kustoInstallWritableGuard(editor) {
	try {
		if (!editor) return;
		if (typeof MutationObserver === 'undefined') return;
		if (__kustoWritableGuardsByEditor && __kustoWritableGuardsByEditor.get(editor)) {
			return;
		}
		const dom = (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
		if (!dom || typeof dom.querySelector !== 'function') {
			return;
		}

		let pending = false;
		const schedule = () => {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
			}, 0);
		};

		const observer = new MutationObserver((mutations) => {
			try {
				for (const m of mutations || []) {
					if (!m || m.type !== 'attributes') continue;
					const t = m.target;
					if (!t || t.tagName !== 'TEXTAREA') continue;
					const a = String(m.attributeName || '').toLowerCase();
					if (a === 'readonly' || a === 'disabled' || a === 'aria-disabled') {
						schedule();
						return;
					}
				}
			} catch {
				// ignore
			}
		});

		observer.observe(dom, {
			subtree: true,
			attributes: true,
			attributeFilter: ['readonly', 'disabled', 'aria-disabled']
		});
		if (__kustoWritableGuardsByEditor) {
			__kustoWritableGuardsByEditor.set(editor, observer);
		}
		// Run once right away.
		schedule();
	} catch {
		// ignore
	}
}

function __kustoEnsureEditorWritableSoon(editor) {
	try {
		// Retry a few times; this avoids relying on a single timing point.
		const delays = [0, 50, 250, 1000];
		for (const d of delays) {
			setTimeout(() => {
				try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
			}, d);
		}
		try { __kustoInstallWritableGuard(editor); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoEnsureAllEditorsWritableSoon() {
	try {
		const maps = [];
		try {
			if (typeof queryEditors !== 'undefined' && queryEditors) maps.push(queryEditors);
		} catch { /* ignore */ }
		try {
			if (typeof markdownEditors !== 'undefined' && markdownEditors) maps.push(markdownEditors);
		} catch { /* ignore */ }
		try {
			if (typeof pythonEditors !== 'undefined' && pythonEditors) maps.push(pythonEditors);
		} catch { /* ignore */ }

		for (const m of maps) {
			try {
				for (const ed of Object.values(m || {})) {
					if (!ed) continue;
					try { __kustoEnsureEditorWritableSoon(ed); } catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
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

		// If an editor instance already exists, ensure it's still attached to this container.
		// If it's stale (detached due to DOM teardown), dispose and recreate.
		try {
			const existing = queryEditors && queryEditors[boxId] ? queryEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete queryEditors[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		// Ensure flex sizing doesn't allow the editor container to expand with content.
		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid calling editor.setValue() during initialization; pass initial value into create()
		// to reduce async timing races in VS Code webviews.
		let initialValue = '';
		try {
			const pending = window.__kustoPendingQueryTextByBoxId && window.__kustoPendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingQueryTextByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'kusto',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			// Autocomplete should be manual-only (Ctrl+Space / toolbar) unless explicitly triggered by code.
			suggestOnTriggerCharacters: false,
			quickSuggestions: false,
			quickSuggestionsDelay: 0,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		queryEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try { __kustoEnsureEditorWritableSoon(editor); } catch { /* ignore */ }
		try { __kustoInstallWritableGuard(editor); } catch { /* ignore */ }
		// Auto-resize this editor to show full content, until the user manually resizes.
		try { __kustoAttachAutoResizeToContent(editor, container); } catch { /* ignore */ }

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

		// Trigger suggest, then auto-hide it if Monaco has nothing to show.
		const __kustoHideSuggestIfNoSuggestions = (ed) => {
			try {
				const root = (ed && typeof ed.getDomNode === 'function') ? ed.getDomNode() : null;
				if (!root || typeof root.querySelector !== 'function') {
					return;
				}
				const widget = root.querySelector('.suggest-widget');
				if (!widget) {
					return;
				}
				const text = String(widget.textContent || '').toLowerCase();
				const hasNoSuggestionsText = text.includes('no suggestions');
				const hasRows = !!(widget.querySelector && widget.querySelector('.monaco-list-row'));
				if (hasNoSuggestionsText || !hasRows) {
					try { ed.trigger('keyboard', 'hideSuggestWidget', {}); } catch { /* ignore */ }
					try { ed.trigger('keyboard', 'editor.action.hideSuggestWidget', {}); } catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
		};

		const __kustoTriggerAutocomplete = (ed) => {
			try {
				if (!ed) return;
				ed.trigger('keyboard', 'editor.action.triggerSuggest', {});
				// Run twice: immediate and after async providers settle.
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed), 0);
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed), 120);
			} catch {
				// ignore
			}
		};

		// Expose for toolbar / other scripts.
		try {
			if (typeof window.__kustoTriggerAutocompleteForBoxId !== 'function') {
				window.__kustoTriggerAutocompleteForBoxId = (id) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (ed) {
							__kustoTriggerAutocomplete(ed);
						}
					} catch {
						// ignore
					}
				};
			}
		} catch {
			// ignore
		}

		// Ensure Ctrl+Space always triggers autocomplete inside the webview.
		try {
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
				__kustoTriggerAutocomplete(editor);
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
			// Render above Monaco suggest/hover widgets and our own banners/modals.
			dom.style.zIndex = '2147483647';
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
									// Default to enabled if the global toggle hasn't been initialized yet.
									try {
										if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
											hide();
											return;
										}
									} catch {
										// ignore
									}

								// Prefer the explicit "active editor" tracking. In some Monaco builds,
								// hasTextFocus/hasWidgetFocus can be unreliable while the suggest widget is open.
								try {
									const activeId = (typeof activeQueryEditorBoxId !== 'undefined' && activeQueryEditorBoxId)
										? String(activeQueryEditorBoxId)
										: null;
									if (activeId && activeId !== String(boxId)) {
										hide();
										return;
									}
								} catch {
									// ignore
								}
					const model = editor.getModel();
					const pos = editor.getPosition();
					const sel = editor.getSelection();
					if (!model || !pos || !sel || !sel.isEmpty()) {
						hide();
						return;
					}
									// Note: we intentionally do NOT hide the tooltip when the caret is after ')'
									// so function docs still show for completed calls like dcountif().
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
					// Monaco has changed what getScrolledVisiblePosition() is relative to across versions.
					// Sometimes it's editor root; sometimes it's the scrollable element.
					// Detect which coordinate-space we're in to keep the tooltip aligned.
					let scrollableRect = null;
					try {
						const scrollable = editorDom.querySelector && editorDom.querySelector('.monaco-scrollable-element');
						if (scrollable && typeof scrollable.getBoundingClientRect === 'function') {
							scrollableRect = scrollable.getBoundingClientRect();
						}
					} catch {
						scrollableRect = null;
					}

					let anchorRect = editorRect;
					if (scrollableRect) {
						const dx = scrollableRect.left - editorRect.left;
						const dy = scrollableRect.top - editorRect.top;
						// If coords are smaller than the gutter/padding offset, they're almost certainly
						// relative to the scrollable element.
						if (coords.left < Math.max(0, dx - 1) || coords.top < Math.max(0, dy - 1)) {
							anchorRect = scrollableRect;
						}
					}

					// Caret in viewport coordinates.
					const caretX = anchorRect.left + coords.left;
					const caretHeight = coords.height || 16;
					const cursorY = anchorRect.top + coords.top + caretHeight;

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
					try {
						if (typeof caretDocOverlaysByBoxId !== 'undefined' && caretDocOverlaysByBoxId) {
							caretDocOverlaysByBoxId[boxId] = docOverlay;
						}
					} catch { /* ignore */ }

					// Keep the overlay positioned correctly when the outer webview scrolls/resizes.
					// Install once globally to avoid accumulating listeners per editor.
					try {
						if (!window.__kustoCaretDocsViewportListenersInstalled) {
							window.__kustoCaretDocsViewportListenersInstalled = true;
							const refreshActive = () => {
								try {
									if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
										return;
									}
									const overlays = typeof caretDocOverlaysByBoxId !== 'undefined' ? caretDocOverlaysByBoxId : null;
									if (!overlays) {
										return;
									}
									let activeId = null;
									try {
										activeId = typeof activeQueryEditorBoxId !== 'undefined' ? activeQueryEditorBoxId : null;
									} catch {
										activeId = null;
									}
									if (activeId && overlays[activeId] && typeof overlays[activeId].update === 'function') {
										overlays[activeId].update();
									}
								} catch {
									// ignore
								}
							};
							window.addEventListener('scroll', refreshActive, true);
							window.addEventListener('resize', refreshActive);
						}
					} catch {
						// ignore
					}

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
			try {
				if (typeof window.__kustoOnQueryValueChanged === 'function') {
					window.__kustoOnQueryValueChanged(boxId, editor.getValue());
				}
			} catch {
				// ignore
			}
			try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		});
		editor.onDidFocusEditorText(() => {
			activeQueryEditorBoxId = boxId;
			try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
			syncPlaceholder();
			ensureSchemaForBox(boxId);
			scheduleDocUpdate();
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				activeQueryEditorBoxId = boxId;
				try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
				syncPlaceholder();
				scheduleDocUpdate();
			});
			editor.onDidBlurEditorWidget(() => {
				// Some Monaco versions can fire blur(widget) while the suggest widget is opening/closing.
				// Defer and only hide if the editor really isn't focused anymore.
				setTimeout(() => {
					try {
						const stillFocused = isEditorFocused();
						if (!stillFocused) {
							try { docOverlay.hide(); } catch { /* ignore */ }
							if (activeQueryEditorBoxId === boxId) {
								activeQueryEditorBoxId = null;
							}
							syncPlaceholder();
						}
					} catch {
						// ignore
					}
				}, 0);
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
				try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
				focusSoon();
			}, true);
		}

		// Keep a direct hook on the editor container too.
		container.addEventListener('mousedown', () => {
			try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
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

		// Kick off missing-cluster detection for the initial value as well.
		try {
			if (typeof window.__kustoOnQueryValueChanged === 'function') {
				window.__kustoOnQueryValueChanged(boxId, editor.getValue());
			}
		} catch {
			// ignore
		}

		// Note: we intentionally do NOT auto-trigger Monaco suggestions on typing.
		// Users can trigger via Ctrl+Space or the toolbar button.

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
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

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
	}).catch((e) => {
		// If Monaco fails to initialize transiently, retry a few times so the editor
		// doesn't get stuck in a non-interactive placeholder state until reopen.
		try {
			if (queryEditors && queryEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

		let attempt = 0;
		try {
			window.__kustoMonacoInitRetryCountByBoxId = window.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (window.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (query editor).', e); } catch { /* ignore */ }
			return;
		}
		try {
			setTimeout(() => {
				try { initQueryEditor(boxId); } catch { /* ignore */ }
			}, delay);
		} catch {
			// ignore
		}
	});
}
