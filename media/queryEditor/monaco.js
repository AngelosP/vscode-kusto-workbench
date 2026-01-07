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

// Derive `columnsByTable` from `columnTypesByTable` to avoid storing duplicate column lists.
// Falls back to legacy `columnsByTable` if present (older cached schema entries).
const __kustoColumnsByTableCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
function __kustoGetColumnsByTable(schema) {
	try {
		if (!schema || typeof schema !== 'object') return null;
		if (schema.columnsByTable && typeof schema.columnsByTable === 'object') return schema.columnsByTable;
		const types = schema.columnTypesByTable;
		if (!types || typeof types !== 'object') return null;
		if (__kustoColumnsByTableCache) {
			const cached = __kustoColumnsByTableCache.get(schema);
			if (cached) return cached;
		}
		const out = {};
		for (const t of Object.keys(types)) {
			const m = types[t];
			if (!m || typeof m !== 'object') continue;
			out[t] = Object.keys(m).map((c) => String(c)).sort((a, b) => a.localeCompare(b));
		}
		if (__kustoColumnsByTableCache) {
			__kustoColumnsByTableCache.set(schema, out);
		}
		return out;
	} catch {
		return null;
	}
}

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
						'filter': {
							signature: '| filter Predicate',
							description: 'Filters rows using a boolean predicate (alias of where in many contexts).'
						},
						'count': {
							signature: '| count',
							description: 'Counts the number of records in the input and returns a single row (typically with a Count column).'
						},
						'extend': {
							signature: '| extend Column = Expression[, ...]',
							description: 'Adds calculated columns to the result set.'
						},
						'project': {
							signature: '| project Column[, ...]',
							description: 'Selects and optionally renames columns.'
						},
						'project-reorder': {
							signature: '| project-reorder Column[, ...]',
							description: 'Reorders columns in the result set (and can also project/select columns depending on usage).'
						},
						'project-smart': {
							signature: '| project-smart Column[, ...]',
							description: 'Projects columns while keeping some additional useful columns (best-effort behavior; exact semantics depend on Kusto implementation).'
						},
						'join': {
							signature: '| join kind=... (RightTable) on Key',
							description: 'Combines rows from two tables using a matching key.'
						},
						'lookup': {
							signature: '| lookup kind=... (RightTable) on Key',
							description: 'Performs a lookup (a specialized join) to bring columns from a right-side table into the left-side results.'
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
						'parse': {
							signature: '| parse Expression with Pattern',
							description: 'Extracts values from a string expression into new columns based on a pattern.'
						},
						'parse-where': {
							signature: '| parse-where Expression with Pattern',
							description: 'Like parse, but keeps only rows that match the pattern.'
						},
						'make-series': {
							signature: '| make-series ...',
							description: 'Creates time series from input data by aggregating values into a range of bins (commonly over time).'
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
						{ label: 'filter', insert: 'filter ', docKey: 'where' },
						{ label: 'extend', insert: 'extend ', docKey: 'extend' },
						{ label: 'project', insert: 'project ', docKey: 'project' },
						{ label: 'project-away', insert: 'project-away ', docKey: 'project-away' },
						{ label: 'project-keep', insert: 'project-keep ', docKey: 'project-keep' },
						{ label: 'project-rename', insert: 'project-rename ', docKey: 'project-rename' },
						{ label: 'project-reorder', insert: 'project-reorder ', docKey: 'project-reorder' },
						{ label: 'project-smart', insert: 'project-smart ', docKey: 'project-smart' },
						{ label: 'summarize', insert: 'summarize ', docKey: 'summarize' },
						{ label: 'count', insert: 'count', docKey: 'count' },
						{ label: 'join', insert: 'join ', docKey: 'join' },
						{ label: 'lookup', insert: 'lookup ', docKey: 'lookup' },
						{ label: 'distinct', insert: 'distinct ', docKey: 'distinct' },
						{ label: 'take', insert: 'take ', docKey: 'take' },
						{ label: 'limit', insert: 'limit ', docKey: 'limit' },
						{ label: 'sample', insert: 'sample ', docKey: 'sample' },
						{ label: 'top', insert: 'top ', docKey: 'top' },
						{ label: 'order by', insert: 'order by ', docKey: 'order by' },
						{ label: 'sort by', insert: 'sort by ', docKey: 'sort by' },
						{ label: 'union', insert: 'union ', docKey: 'union' },
						{ label: 'search', insert: 'search ', docKey: 'search' },
						{ label: 'render', insert: 'render ', docKey: 'render' },
						{ label: 'mv-expand', insert: 'mv-expand ', docKey: 'mv-expand' },
						{ label: 'parse', insert: 'parse ', docKey: 'parse' },
						{ label: 'parse-where', insert: 'parse-where ', docKey: 'parse' },
						{ label: 'make-series', insert: 'make-series ', docKey: 'make-series' }
					];

					const KUSTO_FUNCTION_DOCS = {
						'dcount': {
							args: ['expr', 'accuracy?'],
							returnType: 'long',
							description: 'Returns the number of distinct values of expr.'
						},
						'count': {
							args: ['expr?'],
							returnType: 'long',
							description: 'Counts rows (or non-empty values of expr if provided).'
						},
						'isnotempty': {
							args: ['expr'],
							returnType: 'bool',
							description: 'Returns true if expr is not empty.'
						},
						'isempty': {
							args: ['expr'],
							returnType: 'bool',
							description: 'Returns true if expr is empty.'
						},
						'isnull': {
							args: ['expr'],
							returnType: 'bool',
							description: 'Returns true if expr is null.'
						},
						'isnotnull': {
							args: ['expr'],
							returnType: 'bool',
							description: 'Returns true if expr is not null.'
						},
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
						},
						'sum': {
							args: ['expr'],
							returnType: 'real',
							description: 'Sums expr over the group.'
						},
						'avg': {
							args: ['expr'],
							returnType: 'real',
							description: 'Averages expr over the group.'
						},
						'min': {
							args: ['expr'],
							returnType: 'scalar',
							description: 'Returns the minimum value of expr over the group.'
						},
						'max': {
							args: ['expr'],
							returnType: 'scalar',
							description: 'Returns the maximum value of expr over the group.'
						},
						'percentile': {
							args: ['expr', 'percentile'],
							returnType: 'real',
							description: 'Returns the approximate percentile of expr over the group.'
						},
						'round': {
							args: ['number', 'digits?'],
							returnType: 'real',
							description: 'Rounds number to the specified number of digits.'
						},
						'floor': {
							args: ['number'],
							returnType: 'real',
							description: 'Rounds number down to the nearest integer.'
						},
						'ceiling': {
							args: ['number'],
							returnType: 'real',
							description: 'Rounds number up to the nearest integer.'
						},
						'abs': {
							args: ['number'],
							returnType: 'real',
							description: 'Returns the absolute value of number.'
						},
						'iff': {
							args: ['condition', 'then', 'else'],
							returnType: 'scalar',
							description: 'Returns then if condition is true, else returns else.'
						},
						'iif': {
							args: ['condition', 'then', 'else'],
							returnType: 'scalar',
							description: 'Returns then if condition is true, else returns else.'
						},
						'if': {
							args: ['condition', 'then', 'else'],
							returnType: 'scalar',
							description: 'Conditional expression (use like iff/iif): returns then if condition is true, else returns else.'
						},
						'case': {
							args: ['condition1', 'then1', '...', 'else'],
							returnType: 'scalar',
							description: 'Evaluates conditions in order and returns the matching then value; otherwise returns else.'
						},
						'tostring': {
							args: ['value'],
							returnType: 'string',
							description: 'Converts value to a string.'
						},
						'toint': {
							args: ['value'],
							returnType: 'int',
							description: 'Converts value to an int.'
						},
						'tolong': {
							args: ['value'],
							returnType: 'long',
							description: 'Converts value to a long.'
						},
						'todouble': {
							args: ['value'],
							returnType: 'real',
							description: 'Converts value to a double/real.'
						},
						'todatetime': {
							args: ['value'],
							returnType: 'datetime',
							description: 'Converts value to a datetime.'
						},
						'totimespan': {
							args: ['value'],
							returnType: 'timespan',
							description: 'Converts value to a timespan.'
						},
						'tolower': {
							args: ['text'],
							returnType: 'string',
							description: 'Converts text to lowercase.'
						},
						'toupper': {
							args: ['text'],
							returnType: 'string',
							description: 'Converts text to uppercase.'
						},
						'strlen': {
							args: ['text'],
							returnType: 'int',
							description: 'Returns the length of text.'
						},
						'substring': {
							args: ['text', 'start', 'length?'],
							returnType: 'string',
							description: 'Returns a substring of text.'
						},
						'strcat': {
							args: ['arg1', 'arg2', '...'],
							returnType: 'string',
							description: 'Concatenates arguments into a single string.'
						},
						'replace_string': {
							args: ['text', 'lookup', 'replacement'],
							returnType: 'string',
							description: 'Replaces all occurrences of lookup in text with replacement.'
						},
						'split': {
							args: ['text', 'delimiter'],
							returnType: 'dynamic',
							description: 'Splits text by delimiter and returns an array.'
						},
						'trim': {
							args: ['regex', 'text'],
							returnType: 'string',
							description: 'Trims characters matching regex from the start and end of text.'
						},
						'trim_start': {
							args: ['regex', 'text'],
							returnType: 'string',
							description: 'Trims characters matching regex from the start of text.'
						},
						'trim_end': {
							args: ['regex', 'text'],
							returnType: 'string',
							description: 'Trims characters matching regex from the end of text.'
						},
						'coalesce': {
							args: ['arg1', 'arg2', '...'],
							returnType: 'scalar',
							description: 'Returns the first non-null (and non-empty, depending on type) argument.'
						},
						'parse_json': {
							args: ['text'],
							returnType: 'dynamic',
							description: 'Parses a JSON string into a dynamic value.'
						},
						'extract': {
							args: ['regex', 'captureGroup', 'text'],
							returnType: 'string',
							description: 'Extracts a substring using a regular expression capture group.'
						},
						'format_datetime': {
							args: ['datetime', 'format'],
							returnType: 'string',
							description: 'Formats a datetime using a format string.'
						},
						'bin': {
							args: ['value', 'roundTo'],
							returnType: 'scalar',
							description: 'Rounds value down to a multiple of roundTo (commonly used for time bucketing).' 
						},
						'ago': {
							args: ['timespan'],
							returnType: 'datetime',
							description: 'Returns a datetime equal to now() minus the specified timespan.'
						},
						'datetime_add': {
							args: ['part', 'value', 'datetime'],
							returnType: 'datetime',
							description: 'Adds a specified amount of time to a datetime.'
						},
						'datetime_diff': {
							args: ['part', 'datetime1', 'datetime2'],
							returnType: 'long',
							description: 'Returns the difference between two datetimes in units of part.'
						},
						'datetime_part': {
							args: ['part', 'datetime'],
							returnType: 'long',
							description: 'Extracts a specific part (like year/month/day) from a datetime.'
						},
						'isnan': {
							args: ['number'],
							returnType: 'bool',
							description: 'Returns true if number is NaN (not a number).'
						},
						'isfinite': {
							args: ['number'],
							returnType: 'bool',
							description: 'Returns true if number is finite (not NaN or infinity).'
						}
					};

					const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
					const isIdentStart = (ch) => /[A-Za-z_]/.test(ch);

					// --- Kusto control/management commands (dot-prefixed) ---
					// Data is provided by `media/queryEditor/controlCommands.generated.js`.
					const KUSTO_CONTROL_COMMAND_DOCS_BASE_URL = 'https://learn.microsoft.com/en-us/kusto/';
					const KUSTO_CONTROL_COMMAND_DOCS_VIEW = 'azure-data-explorer';
					const KUSTO_CONTROL_COMMAND_DOCS_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

					const __kustoNormalizeControlCommand = (s) => {
						let v = String(s || '').replace(/\s+/g, ' ').trim();
						if (!v.startsWith('.')) return '';
						// Many TOC titles include a trailing "command" word; strip it when it looks like metadata.
						const parts = v.split(' ').filter(Boolean);
						if (parts.length >= 3 && /^command$/i.test(parts[parts.length - 1])) {
							parts.pop();
							v = parts.join(' ');
						}
						return v;
					};

					const __kustoBuildControlCommandIndex = () => {
						const raw = (typeof window !== 'undefined' && Array.isArray(window.__kustoControlCommandEntries))
							? window.__kustoControlCommandEntries
							: [];
						const byLower = new Map();
						for (const ent of raw) {
							const title = Array.isArray(ent) ? ent[0] : (ent && ent.title);
							const href = Array.isArray(ent) ? ent[1] : (ent && ent.href);
							if (!title || !href) continue;
							for (const aliasRaw of String(title).split(',')) {
								const base = String(aliasRaw || '').trim();
								if (!base) continue;
								const alts = base.includes('|') ? base.split('|').map(s => String(s || '').trim()) : [base];
								for (const alias of alts) {
									if (!alias.startsWith('.')) continue;
									const cmd = __kustoNormalizeControlCommand(alias);
									if (!cmd) continue;
									const key = cmd.toLowerCase();
									if (!byLower.has(key)) {
										byLower.set(key, { command: cmd, commandLower: key, title: alias, href: String(href) });
									}
								}
							}
						}
						const items = Array.from(byLower.values());
						// Prefer longest match for hover resolution.
						items.sort((a, b) => (b.commandLower.length - a.commandLower.length) || a.commandLower.localeCompare(b.commandLower));
						return items;
					};

					const __kustoControlCommands = __kustoBuildControlCommandIndex();

					const __kustoGetOrInitControlCommandDocCache = () => {
						try {
							if (!window.__kustoControlCommandDocCache || typeof window.__kustoControlCommandDocCache !== 'object') {
								window.__kustoControlCommandDocCache = {};
							}
							if (!window.__kustoControlCommandDocPending || typeof window.__kustoControlCommandDocPending !== 'object') {
								window.__kustoControlCommandDocPending = {};
							}
							return window.__kustoControlCommandDocCache;
						} catch {
							return {};
						}
					};

					const __kustoParseControlCommandSyntaxFromLearnHtml = (html) => {
						try {
							const s = String(html || '');
							if (!s.trim()) return null;
							let doc = null;
							try {
								if (typeof DOMParser !== 'undefined') {
									doc = new DOMParser().parseFromString(s, 'text/html');
								}
							} catch {
								doc = null;
							}

						const cleanCode = (code) => {
							const raw = String(code || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
							// Trim leading/trailing blank lines while preserving inner formatting.
							const lines = raw.split('\n');
							while (lines.length && !String(lines[0] || '').trim()) lines.shift();
							while (lines.length && !String(lines[lines.length - 1] || '').trim()) lines.pop();
							return lines.join('\n').trim();
						};

						if (doc) {
							// Find the "Syntax" heading and the first <pre><code> after it.
							const headings = Array.from(doc.querySelectorAll('h2, h3'));
							let syntaxHeading = null;
							for (const h of headings) {
								const t = String(h && h.textContent ? h.textContent : '').trim().toLowerCase();
								if (t === 'syntax') { syntaxHeading = h; break; }
							}
							if (syntaxHeading) {
								let el = syntaxHeading.nextElementSibling;
								for (let guard = 0; el && guard < 80; guard++, el = el.nextElementSibling) {
									const tag = String(el.tagName || '').toLowerCase();
									if (tag === 'h2' || tag === 'h3') break;
									const pre = el.matches && el.matches('pre') ? el : (el.querySelector ? el.querySelector('pre') : null);
									if (pre) {
										const code = pre.querySelector ? pre.querySelector('code') : null;
										const txt = cleanCode(code && code.textContent ? code.textContent : pre.textContent);
										if (txt) return txt;
									}
								}
							}

							// Fallback: first code block in the document.
							try {
								const first = doc.querySelector('pre code');
								const txt = cleanCode(first && first.textContent ? first.textContent : '');
								if (txt) return txt;
							} catch { /* ignore */ }
						}

						// Regex fallback if DOMParser isn't available.
						try {
							const m = s.match(/<h2[^>]*>\s*Syntax\s*<\/h2>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
							if (m && m[1]) {
								const inner = String(m[1]).replace(/<[^>]+>/g, '');
								const txt = cleanCode(inner);
								if (txt) return txt;
							}
						} catch { /* ignore */ }

						return null;
					} catch {
						return null;
					}
					};

					const __kustoExtractWithOptionArgsFromSyntax = (syntaxText) => {
						try {
							const s = String(syntaxText || '');
							if (!s) return [];
							// Try to capture the inside of a `with (...)` option list.
							const m = s.match(/\bwith\s*\(([\s\S]*?)\)/i);
							if (!m || !m[1]) return [];
							const inside = String(m[1]);
							const out = [];
							const seen = new Set();
							for (const mm of inside.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
								const name = String(mm[1] || '').trim();
								if (!name) continue;
								const lower = name.toLowerCase();
								if (seen.has(lower)) continue;
								seen.add(lower);
								out.push(name);
							}
							return out;
						} catch {
							return [];
						}
					};

					const __kustoScheduleFetchControlCommandSyntax = (cmd) => {
						try {
							if (!cmd || !cmd.commandLower || !cmd.href) return;
							const cache = __kustoGetOrInitControlCommandDocCache();
							const key = String(cmd.commandLower);
							const entry = cache[key];
							const now = Date.now();
							if (entry && entry.fetchedAt && (now - entry.fetchedAt) < KUSTO_CONTROL_COMMAND_DOCS_CACHE_TTL_MS && entry.syntax) {
								return;
							}
							if (window.__kustoControlCommandDocPending && window.__kustoControlCommandDocPending[key]) return;
							const requestId = `ccs_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
							window.__kustoControlCommandDocPending[key] = requestId;
							try {
								if (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function') {
									vscode.postMessage({
										type: 'fetchControlCommandSyntax',
										requestId,
										commandLower: key,
										href: String(cmd.href)
									});
								}
							} catch { /* ignore */ }
						} catch {
							// ignore
						}
					};

					const __kustoFindEnclosingWithOptionsParen = (model, statementStartOffset, cursorOffset) => {
						try {
							const full = model.getValue();
							const start = Math.max(0, Number(statementStartOffset) || 0);
							const end = Math.max(start, Math.min(full.length, Number(cursorOffset) || 0));
							const slice = full.slice(start, end);
							const lower = slice.toLowerCase();
							const idx = lower.lastIndexOf('with');
							if (idx < 0) return null;
							const after = slice.slice(idx + 4);
							const m = after.match(/^\s*\(/);
							if (!m) return null;
							const openRel = idx + 4 + (m[0].length - 1);
							const openAbs = start + openRel;
							if (openAbs >= end) return null;
							// Verify the paren is still open at cursor.
							let depth = 0;
							let inSingle = false;
							let inDouble = false;
							for (let i = openAbs; i < end; i++) {
								const ch = full[i];
								if (ch === '"') {
									if (!inSingle) {
										// Basic support for backslash-escaped double quotes.
										if (full[i - 1] !== '\\') {
											inDouble = !inDouble;
										}
									}
									continue;
								}
								if (ch === "'") {
									const next = full[i + 1];
									if (next === "'") { i++; continue; }
									inSingle = !inSingle;
									continue;
								}
								if (inSingle || inDouble) continue;
								if (ch === '(') depth++;
								else if (ch === ')') {
									depth--;
									if (depth <= 0) return null;
								}
							}
							return openAbs;
						} catch {
							return null;
						}
					};

					const __kustoFindWithOptionsParenRange = (text, statementStartOffset) => {
						try {
							const full = String(text || '');
							const start = Math.max(0, Number(statementStartOffset) || 0);
							const slice = full.slice(start, Math.min(full.length, start + 4000));
							if (!slice) return null;

							let inLineComment = false;
							let inBlockComment = false;
							let inSingle = false;
							let inDouble = false;

							const isIdentPart = (ch) => /[A-Za-z0-9_\-]/.test(ch);
							const eqIgnoreCaseAt = (i, word) => slice.substr(i, word.length).toLowerCase() === word;

							for (let i = 0; i < slice.length; i++) {
								const ch = slice[i];
								const next = slice[i + 1];

								if (inLineComment) {
									if (ch === '\n') inLineComment = false;
									continue;
								}
								if (inBlockComment) {
									if (ch === '*' && next === '/') { inBlockComment = false; i++; }
									continue;
								}
								if (inSingle) {
									if (ch === "'") {
										if (next === "'") { i++; continue; }
										inSingle = false;
									}
									continue;
								}
								if (inDouble) {
									if (ch === '"') {
										// Basic support for backslash escapes inside quotes.
										if (slice[i - 1] !== '\\') {
											inDouble = false;
										}
									}
									continue;
								}

								if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
								if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
								if (ch === "'") { inSingle = true; continue; }
								if (ch === '"') { inDouble = true; continue; }

								if (!eqIgnoreCaseAt(i, 'with')) continue;
								const prev = i > 0 ? slice[i - 1] : '';
								const afterWord = i + 4 < slice.length ? slice[i + 4] : '';
								if ((prev && isIdentPart(prev)) || (afterWord && isIdentPart(afterWord))) continue;

								let j = i + 4;
								while (j < slice.length && /\s/.test(slice[j])) j++;
								if (slice[j] !== '(') continue;
								const openRel = j;
								let depth = 0;
								let inS = false;
								let inD = false;
								for (let k = j; k < slice.length; k++) {
									const c = slice[k];
									const n = slice[k + 1];
									if (inS) {
										if (c === "'") {
											if (n === "'") { k++; continue; }
											inS = false;
										}
										continue;
									}
									if (inD) {
										if (c === '"' && slice[k - 1] !== '\\') { inD = false; }
										continue;
									}
									if (c === "'") { inS = true; continue; }
									if (c === '"') { inD = true; continue; }
									if (c === '/' && n === '/') {
										const nl = slice.indexOf('\n', k + 2);
										if (nl < 0) break;
										k = nl;
										continue;
									}
									if (c === '/' && n === '*') {
										const end = slice.indexOf('*/', k + 2);
										if (end < 0) break;
										k = end + 1;
										continue;
									}
									if (c === '(') depth++;
									else if (c === ')') {
										depth--;
										if (depth === 0) {
											return { open: start + openRel, close: start + k };
										}
									}
								}
								return null;
							}
							return null;
						} catch {
							return null;
						}
					};

					const __kustoTryGetDotCommandCompletionContext = (model, position, statementStartInCursorText, statementTextUpToCursor) => {
						try {
							const stmt = String(statementTextUpToCursor || '');
							const m = stmt.match(/^\s*\.([A-Za-z0-9_\-]*)$/);
							if (!m) return null;
							const fragmentLower = String(m[1] || '').toLowerCase();
							const dotMatch = stmt.match(/^\s*\./);
							if (!dotMatch) return null;
							const dotOffsetInStmt = dotMatch[0].length - 1;
							const dotAbsOffset = Math.max(0, (Number(statementStartInCursorText) || 0) + dotOffsetInStmt);
							const dotPos = model.getPositionAt(dotAbsOffset);
							// Dot-command completion is only intended for the statement header line.
							if (dotPos.lineNumber !== position.lineNumber) return null;
							const replaceRange = new monaco.Range(dotPos.lineNumber, dotPos.column, position.lineNumber, position.column);
							return { fragmentLower, replaceRange };
						} catch {
							return null;
						}
					};

					const __kustoGetControlCommandHoverAt = (model, position) => {
						try {
							if (!__kustoControlCommands || __kustoControlCommands.length === 0) return null;
							const full = model.getValue();
							if (!full) return null;
							const offset = model.getOffsetAt(position);
							const statementStart = __kustoGetStatementStartAtOffset(full, offset);
							const stmtPrefix = String(full.slice(statementStart, Math.min(full.length, statementStart + 400)));
							const trimmed = stmtPrefix.replace(/^\s+/g, '');
							if (!trimmed.startsWith('.')) return null;
							const prefixLower = trimmed.toLowerCase();
							let best = null;
							for (const cmd of __kustoControlCommands) {
								if (!prefixLower.startsWith(cmd.commandLower)) continue;
								const next = prefixLower.charAt(cmd.commandLower.length);
								if (next && !/\s|\(|<|;/.test(next)) continue;
								best = cmd;
								break; // already sorted by longest
							}
							if (!best) return null;

							const wsPrefixLen = stmtPrefix.length - trimmed.length;
							const commandStartOffset = statementStart + wsPrefixLen;
							const commandEndOffset = commandStartOffset + best.command.length;
							if (offset < commandStartOffset) {
								// Hide control-command docs once caret moves before the '.'
								return null;
							}
							// If the command has a with(...) option list, keep docs visible only until its closing ')'.
							const withRange = __kustoFindWithOptionsParenRange(full, statementStart);
							const maxOffset = (withRange && typeof withRange.close === 'number') ? Math.max(commandEndOffset, withRange.close) : commandEndOffset;
							if (offset > maxOffset) {
								// Hide once caret moves past the relevant signature/options region.
								return null;
							}

							// Kick off background fetch for syntax/args so the banner can show more than a link.
							try { __kustoScheduleFetchControlCommandSyntax(best); } catch { /* ignore */ }
							const cache = __kustoGetOrInitControlCommandDocCache();
							const cached = cache ? cache[String(best.commandLower)] : null;

							// If the caret is inside `with (...)`, highlight the active option argument.
							let signature = best.command;
							try {
								const withArgs = cached && Array.isArray(cached.withArgs) ? cached.withArgs : [];
								if (withArgs.length) {
									const openParen = __kustoFindEnclosingWithOptionsParen(model, statementStart, offset);
									let active = -1;
									if (typeof openParen === 'number') {
										active = computeArgIndex(model, openParen, offset);
										active = Math.max(0, Math.min(active, withArgs.length - 1));
									}
									const formatted = withArgs
										.map((a, i) => (i === active ? `**${a}**=` : `${a}=`))
										.join(', ');
									signature = `${best.command} with (${formatted}...)`;
								}
							} catch { /* ignore */ }

							const startPos = model.getPositionAt(statementStart + wsPrefixLen);
							const endPos = model.getPositionAt(statementStart + wsPrefixLen + best.command.length);
							const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
							const url = new URL(best.href, KUSTO_CONTROL_COMMAND_DOCS_BASE_URL);
							url.searchParams.set('view', KUSTO_CONTROL_COMMAND_DOCS_VIEW);
							let markdown = `\`${signature}\``;
							try {
								const syntax = cached && cached.syntax ? String(cached.syntax) : '';
								if (syntax) {
									const lines = syntax.split('\n').map(s => String(s || '').trimRight());
									const preview = lines.slice(0, 3).join('\n').trim();
									if (preview) {
										markdown += `\n${preview}`;
									}
								}
							} catch { /* ignore */ }
							return { range, markdown, __kustoKind: 'controlCommand', __kustoStartOffset: commandStartOffset, __kustoMaxOffset: maxOffset };
						} catch {
							return null;
						}
					};

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

						const inferPipeOperatorHoverFromLine = () => {
							try {
								const lineNumber = position.lineNumber;
								const line = model.getLineContent(lineNumber);
								if (!line) return null;
								const col0 = Math.max(0, Math.min(line.length, position.column - 1));
								const before = line.slice(0, col0);
								const pipeIdx = before.lastIndexOf('|');
								if (pipeIdx < 0) return null;
								// Only consider it a pipe clause if everything before the '|' is whitespace.
								if (!/^\s*$/.test(before.slice(0, pipeIdx))) return null;

								const afterPipe = line.slice(pipeIdx + 1);
								// Match a known operator at the start of the pipe clause.
								const m = afterPipe.match(/^\s*(order\s+by|sort\s+by|project-away|project-keep|project-rename|project-reorder|project-smart|mv-expand|where|filter|extend|project|summarize|count|join|lookup|distinct|take|top|limit|sample|render|union|search|parse|parse-where|make-series)\b/i);
								if (!m) return null;
								let key = String(m[1] || '').toLowerCase().replace(/\s+/g, ' ').trim();
								if (key === 'filter') key = 'where';
								if (key === 'parse-where') key = 'parse';
								const doc = KUSTO_KEYWORD_DOCS[key];
								if (!doc) return null;

								// Range over the operator keyword (not the whole clause).
								const ws = afterPipe.match(/^\s*/);
								const leadingWsLen = ws ? ws[0].length : 0;
								const opStartIdx = pipeIdx + 1 + leadingWsLen;
								const opEndIdx = opStartIdx + m[0].trim().length;
								const range = new monaco.Range(lineNumber, opStartIdx + 1, lineNumber, opEndIdx + 1);
								const md = `\`${doc.signature}\`\n\n${doc.description || ''}`.trim();
								return { range, markdown: md };
							} catch {
								return null;
							}
						};

						const inferPipeOperatorHoverFromContext = () => {
							try {
								// Fast path: same-line pipe clause.
								const sameLine = inferPipeOperatorHoverFromLine();
								if (sameLine) return sameLine;

								// Multi-line clauses: scan upward for the most recent pipe clause start.
								const maxScanLines = 30;
								let pipeLine = -1;
								let pipeIdx = -1;
								for (let ln = position.lineNumber; ln >= 1 && (position.lineNumber - ln) <= maxScanLines; ln--) {
									const line = model.getLineContent(ln);
									if (typeof line !== 'string') continue;
									const slice = (ln === position.lineNumber)
										? line.slice(0, Math.max(0, Math.min(line.length, position.column - 1)))
										: line;
									const idx = slice.lastIndexOf('|');
									if (idx < 0) continue;
									// Only consider it a pipe clause if everything before the '|' is whitespace.
									if (!/^\s*$/.test(slice.slice(0, idx))) continue;
									pipeLine = ln;
									pipeIdx = idx;
									break;
								}
								if (pipeLine < 0 || pipeIdx < 0) return null;

								// Build a small forward-looking snippet starting after the pipe, spanning multiple lines,
								// so we can match operators even if they are placed on the next line.
								const pipePos = new monaco.Position(pipeLine, pipeIdx + 1);
								let startOffset;
								try {
									startOffset = model.getOffsetAt(pipePos) + 1; // after '|'
								} catch {
									return null;
								}
								const full = model.getValue();
								if (!full || startOffset >= full.length) return null;
								const snippet = full.slice(startOffset, Math.min(full.length, startOffset + 500));
								const m = snippet.match(/^\s*(order\s+by|sort\s+by|project-away|project-keep|project-rename|project-reorder|project-smart|mv-expand|where|filter|extend|project|summarize|count|join|lookup|distinct|take|top|limit|sample|render|union|search|parse|parse-where|make-series)\b/i);
								if (!m) return null;
								let key = String(m[1] || '').toLowerCase().replace(/\s+/g, ' ').trim();
								if (key === 'filter') key = 'where';
								if (key === 'parse-where') key = 'parse';
								const doc = KUSTO_KEYWORD_DOCS[key];
								if (!doc) return null;

								// Compute a reasonable range for the operator keyword.
								let keywordStart = startOffset;
								try {
									while (keywordStart < full.length && /\s/.test(full[keywordStart])) keywordStart++;
								} catch { /* ignore */ }
								const firstWord = String(m[1] || '').split(/\s+/)[0] || String(m[1] || '');
								const keywordEnd = Math.min(full.length, keywordStart + firstWord.length);
								const startPos = model.getPositionAt(keywordStart);
								const endPos = model.getPositionAt(keywordEnd);
								const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);

								const md = `\`${doc.signature}\`\n\n${doc.description || ''}`.trim();
								return { range, markdown: md };
							} catch {
								return null;
							}
						};

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

						// Dot-prefixed management/control commands: drive hover + caret docs banner.
						const cc = __kustoGetControlCommandHoverAt(model, position);
						if (cc) {
							return cc;
						}

						const token = getTokenAtPosition(model, position);
						if (!token || !token.word) {
							// Even if the caret isn't on a token, keep pipe-operator docs visible while typing the clause.
							return inferPipeOperatorHoverFromContext();
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

						// If the token under the caret isn't itself a keyword/function, infer the active pipe operator
						// for this clause so docs keep showing while the user types the rest of the statement.
						return inferPipeOperatorHoverFromContext();
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
								[/"([^"\\]|\\.)*"/, 'string'],
								[/\b\d+(\.\d+)?\b/, 'number'],
								[/\|/, 'delimiter'],
								[/[=><!~]+/, 'operator'],
								[/\.[a-zA-Z_][\w\-]*/, 'keyword'],
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
							{ open: "'", close: "'" },
							{ open: '"', close: '"' }
						],
						surroundingPairs: [
							{ open: '{', close: '}' },
							{ open: '[', close: ']' },
							{ open: '(', close: ')' },
							{ open: "'", close: "'" },
							{ open: '"', close: '"' }
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
					// Keep a reference to our completion provider so diagnostics can be filtered
					// using the exact same suggestion logic ("if it's in autocomplete, it must not squiggle").
					let __kustoProvideCompletionItemsForDiagnostics = null;
					const __kustoCompletionProvider = {
						triggerCharacters: [' ', '|', '.'],
						provideCompletionItems: async function (model, position) {
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

							const textUpToCursor = model.getValueInRange({
								startLineNumber: 1,
								startColumn: 1,
								endLineNumber: position.lineNumber,
								endColumn: position.column
							});
							const textUpToCursorLower = String(textUpToCursor || '').toLowerCase();

							// Support multi-statement scripts separated by ';' by scoping
							// completion heuristics to the current statement (but still allowing earlier `let` variables).
							// NOTE: Build this from `textUpToCursor` to avoid any offset/EOL mismatches.
							const statementStartInCursorText = __kustoGetStatementStartAtOffset(textUpToCursor, textUpToCursor.length);
							const statementTextUpToCursor = String(textUpToCursor || '').slice(statementStartInCursorText);
							const statementTextUpToCursorLower = String(statementTextUpToCursor || '').toLowerCase();

							const wordUntil = model.getWordUntilPosition(position);
							const typedRaw = (wordUntil && typeof wordUntil.word === 'string') ? wordUntil.word : '';
							const typed = typedRaw.toLowerCase();

							// Dot-prefixed control/management commands (e.g. `.create-or-alter function`).
							// Only offer these at the start of the current statement so we don't pollute query completions.
							const dotCtx = __kustoTryGetDotCommandCompletionContext(model, position, statementStartInCursorText, statementTextUpToCursor);
							if (dotCtx && __kustoControlCommands && __kustoControlCommands.length) {
								for (const cmd of __kustoControlCommands) {
									// Match on the fragment after the leading '.'
									const rest = cmd.commandLower.startsWith('.') ? cmd.commandLower.slice(1) : cmd.commandLower;
									if (dotCtx.fragmentLower && !rest.startsWith(dotCtx.fragmentLower)) continue;
									const url = new URL(cmd.href, KUSTO_CONTROL_COMMAND_DOCS_BASE_URL);
									url.searchParams.set('view', KUSTO_CONTROL_COMMAND_DOCS_VIEW);
									pushSuggestion({
										label: cmd.command,
										kind: monaco.languages.CompletionItemKind.Keyword,
										insertText: cmd.command,
										range: dotCtx.replaceRange,
										sortText: '0_' + cmd.commandLower,
										detail: 'Kusto management command',
										documentation: { value: `[Open documentation](${url.toString()})` }
									}, 'cc:' + cmd.commandLower);
								}
								return { suggestions };
							}

							// If the cursor is inside a function call argument list, completions should include columns
							// even when the operator context regex would otherwise be too strict (e.g. `summarize ... dcount(`).
							let __kustoIsInFunctionArgs = false;
							try {
								const off = model.getOffsetAt(position);
								let call = findEnclosingFunctionCall(model, off);
								if (!call) {
									call = findEnclosingFunctionCall(model, off + 1);
								}
								__kustoIsInFunctionArgs = !!call;
							} catch { /* ignore */ }

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

							// Offer pipe-operator keyword completions after a top-level `|`, even when it appears mid-line
							// (e.g. `Table | <cursor>`), not just when the line starts with `|`.
							const isPipeStatementStart = (() => {
								try {
									const stmt = String(statementTextUpToCursor || '');
									const lastPipe = stmt.lastIndexOf('|');
									if (lastPipe < 0) {
										return /^\s*\|\s*[A-Za-z_\-]*$/i.test(linePrefixRaw);
									}
									const after = stmt.slice(lastPipe + 1);
									return /^\s*[A-Za-z_\-]*$/i.test(after);
								} catch {
									return false;
								}
							})();
							if (isPipeStatementStart) {
								for (const op of KUSTO_PIPE_OPERATOR_SUGGESTIONS) {
									if (typed && !op.label.toLowerCase().startsWith(typed)) {
										continue;
									}
									let detail = undefined;
									let documentation = undefined;
									try {
										const d = (op && op.docKey) ? (KUSTO_KEYWORD_DOCS[op.docKey] || null) : null;
										if (d) {
											detail = d.signature ? String(d.signature) : undefined;
											documentation = d.description ? { value: String(d.description) } : undefined;
										}
									} catch { /* ignore */ }
									pushSuggestion({
										label: op.label,
										kind: monaco.languages.CompletionItemKind.Keyword,
										insertText: op.insert,
										sortText: '0_' + op.label,
										range: replaceRange,
										detail,
										documentation
									}, 'op:' + op.label);
								}
								// At the beginning of a new pipe statement, only show Kusto pipe commands.
								return { suggestions };
							}

							// IMPORTANT: use the full text up to the cursor so multi-line operators like
							// "| summarize\n  X = count()\n  by" still produce column suggestions.
							// Based on KQL operator syntax (KQL quick reference), these operators accept column names and/or expressions.
							const shouldSuggestColumns = /\|\s*(where|filter|project|project-away|project-keep|project-rename|project-reorder|project-smart|extend|summarize|distinct|mv-expand|parse|parse-where|make-series|order\s+by|sort\s+by|take|limit|top)\b[^|]*$/i.test(statementTextUpToCursorLower)
								|| (__kustoIsInFunctionArgs && statementTextUpToCursorLower.indexOf('|') >= 0);

							// Assignment RHS (e.g. "| summarize X = dco" or "| extend Y = Dev") should suggest only functions + columns.
							const lastEq = linePrefixRaw.lastIndexOf('=');
							const isAssignmentRhs = (() => {
								if (lastEq < 0) return false;
								// Only consider '=' that appears after a pipe operator clause begins.
								if (linePrefixRaw.indexOf('|') < 0) return false;
								const after = linePrefixRaw.slice(lastEq + 1);
								if (!/^\s*[A-Za-z_\-]*$/i.test(after)) return false;
								// Heuristic: this is the RHS of extend/summarize style assignments.
								return /\|\s*(extend|summarize)\b/i.test(linePrefixRaw);
							})();

							// Completion is manual-only, so it's OK to include functions broadly when in an expression.
							const shouldSuggestFunctions = shouldSuggestColumns || isAssignmentRhs || /\|\s*(where|extend|project|summarize)\b/i.test(statementTextUpToCursorLower);

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

								// Even without schema, we can still suggest earlier `let` variables (multi-statement scripts).
								try {
									const prefix = String(textUpToCursor || '');
									const toks = __kustoScanIdentifiers(prefix);
									const byLower = new Map();
									for (let i = 0; i < toks.length; i++) {
										const t = toks[i];
										if (!t || t.type !== 'ident' || t.depth !== 0) continue;
										if (String(t.value || '').toLowerCase() !== 'let') continue;
										let nameTok = null;
										for (let j = i + 1; j < toks.length; j++) {
											const tt = toks[j];
											if (!tt || tt.depth !== 0) continue;
											if (tt.type === 'ident') { nameTok = tt; break; }
											if (tt.type === 'pipe') break;
										}
										if (!nameTok || !nameTok.value) continue;
										const after = prefix.slice(nameTok.endOffset, Math.min(prefix.length, nameTok.endOffset + 64));
										if (!/^\s*=/.test(after)) continue;
										byLower.set(String(nameTok.value).toLowerCase(), String(nameTok.value));
									}
									for (const [nl, name] of byLower.entries()) {
										if (typed && !nl.startsWith(typed)) continue;
										pushSuggestion({
											label: name,
											kind: monaco.languages.CompletionItemKind.Variable,
											insertText: name,
											sortText: '0_' + name,
											range: replaceRange
										}, 'let:' + nl);
									}
								} catch { /* ignore */ }

								// Still provide function suggestions so Ctrl+Space isn't empty while schema loads.
								if (shouldSuggestFunctions) {
									// Use the full token/word range so selecting an item replaces the rest of the word.
									const range = replaceRange;
									const __kustoBuildFnInsertText = (fnName, fnDoc) => {
										const args = (fnDoc && Array.isArray(fnDoc.args)) ? fnDoc.args : [];
										const required = args.filter(a => typeof a === 'string' && !a.endsWith('?'));
										if (required.length === 0) {
											return { insertText: fnName + '()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
										}
										const snippetArgs = required.map((a, i) => '${' + (i + 1) + ':' + a + '}').join(', ');
										return { insertText: fnName + '(' + snippetArgs + ')', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
									};
									for (const fn of Object.keys(KUSTO_FUNCTION_DOCS)) {
										if (typed && !fn.toLowerCase().startsWith(typed)) {
											continue;
										}
										const doc = KUSTO_FUNCTION_DOCS[fn];
										const detail = doc && doc.returnType ? String(doc.returnType) : undefined;
										const documentation = doc && doc.description ? { value: String(doc.description) } : undefined;
										const insert = __kustoBuildFnInsertText(fn, doc);
										pushSuggestion({
											label: fn,
											kind: monaco.languages.CompletionItemKind.Function,
											detail,
											documentation,
											insertText: insert.insertText,
											insertTextRules: insert.insertTextRules,
											sortText: '1_' + fn,
											range
										}, 'fn:' + fn);
									}
								}

								return { suggestions };
							}

							const __kustoNormalizeClusterForKusto = (clusterUrl) => {
								let s = String(clusterUrl || '')
									.trim()
									.replace(/^https?:\/\//i, '')
									.replace(/\/+$/, '')
									.replace(/:\d+$/, '');
								// Azure Data Explorer public cloud clusters
								s = s.replace(/\.kusto\.windows\.net$/i, '');
								return s;
							};

							const __kustoParseFullyQualifiedTableExpr = (text) => {
								try {
									const s = String(text || '');
									// cluster('X').database('Y').Table
									const m = s.match(/\bcluster\s*\(\s*'([^']+)'\s*\)\s*\.\s*database\s*\(\s*'([^']+)'\s*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
									if (m && m[1] && m[2] && m[3]) {
										return { cluster: String(m[1]), database: String(m[2]), table: String(m[3]) };
									}
									return null;
								} catch {
									return null;
								}
							};

							const __kustoFindConnectionIdByClusterName = (clusterName) => {
								try {
									const target = __kustoNormalizeClusterForKusto(clusterName).toLowerCase();
									if (!target) return null;
									for (const c of (connections || [])) {
										if (!c || !c.id) continue;
										const url = String(c.clusterUrl || '').trim();
										if (!url) continue;
										const norm = __kustoNormalizeClusterForKusto(url).toLowerCase();
										if (norm === target) {
											return String(c.id);
										}
									}
								} catch { /* ignore */ }
								return null;
							};

							const __kustoEnsureSchemaForClusterDb = async (clusterName, databaseName) => {
								try {
									const cid = __kustoFindConnectionIdByClusterName(clusterName);
									const db = String(databaseName || '').trim();
									if (!cid || !db) return null;
									const key = cid + '|' + db;
									try {
										if (schemaByConnDb && schemaByConnDb[key]) {
											return schemaByConnDb[key];
										}
									} catch { /* ignore */ }
									if (typeof window.__kustoRequestSchema === 'function') {
										const sch = await window.__kustoRequestSchema(cid, db, false);
										try {
											if (sch && schemaByConnDb) {
												schemaByConnDb[key] = sch;
											}
										} catch { /* ignore */ }
										return sch;
									}
								} catch { /* ignore */ }
								return null;
							};

							// Special context: inside `| join ... on ...` or `| lookup ... on ...` we want columns (not tables).
							const __kustoBuildLetTabularResolverForCompletion = (text) => {
								const tablesByLower = {};
								try {
									for (const t of (schema && Array.isArray(schema.tables) ? schema.tables : [])) {
										tablesByLower[String(t).toLowerCase()] = String(t);
									}
								} catch { /* ignore */ }
								const letSources = {};
								const extractSourceLower = (rhsText) => {
									const rhs = String(rhsText || '').trim();
									if (!rhs) return null;
									try {
										const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
										if (m && m[1]) return String(m[1]).toLowerCase();
									} catch { /* ignore */ }
									try {
										const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
										if (m && m[1]) return String(m[1]).toLowerCase();
									} catch { /* ignore */ }
									try {
										const m = rhs.replace(/^\(\s*/g, '').trim().match(/^([A-Za-z_][\w-]*)\b/);
										return (m && m[1]) ? String(m[1]).toLowerCase() : null;
									} catch { return null; }
								};
								try {
									const lines = String(text || '').split(/\r?\n/);
									for (let i = 0; i < lines.length; i++) {
										const trimmed = lines[i].trim();
										if (!/^let\s+/i.test(trimmed)) continue;
										let stmt = lines[i];
										while (i + 1 < lines.length && stmt.indexOf(';') === -1) {
											i++;
											stmt += '\n' + lines[i];
										}
										const m = stmt.match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)(;|$)/i);
										if (!m || !m[1] || !m[2]) continue;
										const letNameLower = String(m[1]).toLowerCase();
										let rhs = String(m[2]).trim();
										const srcLower = extractSourceLower(rhs);
										if (!srcLower) continue;
										letSources[letNameLower] = srcLower;
									}
								} catch { /* ignore */ }
								const resolve = (name) => {
									let cur = String(name || '').toLowerCase();
									for (let depth = 0; depth < 8; depth++) {
										if (tablesByLower[cur]) return tablesByLower[cur];
										if (!letSources[cur]) return null;
										cur = letSources[cur];
									}
									return null;
								};
								return resolve;
							};
							const __kustoResolveToSchemaTableNameForCompletion = (() => {
								const resolveLet = __kustoBuildLetTabularResolverForCompletion(model.getValue());
								return (name) => __kustoFindSchemaTableName(name) || (resolveLet ? resolveLet(name) : null);
							})();

							const __kustoGetLastTopLevelStageText = (text, offset) => {
								try {
									const before = String(text || '').slice(0, Math.max(0, offset));
									// Best-effort: last pipe in the raw text (joins in parentheses are uncommon, but this is still heuristic).
									const idx = before.lastIndexOf('|');
									if (idx < 0) return before.trim();
									return before.slice(idx + 1).trim();
								} catch {
									return '';
								}
							};

							const __kustoIsJoinOrLookupOnContext = (() => {
								try {
									const lastPipe = statementTextUpToCursorLower.lastIndexOf('|');
									if (lastPipe < 0) return false;
									const clause = statementTextUpToCursorLower.slice(lastPipe);
									if (!/^\|\s*(join|lookup)\b/i.test(clause)) return false;
									return /\bon\b/i.test(clause);
								} catch {
									return false;
								}
							})();

							const shouldSuggestColumnsOrJoinOn = shouldSuggestColumns || __kustoIsJoinOrLookupOnContext;
							const shouldSuggestFunctionsOrJoinOn = shouldSuggestFunctions || __kustoIsJoinOrLookupOnContext;

							const __kustoExtractJoinOrLookupRightTable = (clauseText) => {
								try {
									const clause = String(clauseText || '');
									// Prefer (RightTable)
									const paren = clause.match(/\(([^)]*)\)/);
									if (paren && paren[1]) {
										const mName = String(paren[1]).trim().match(/^([A-Za-z_][\w-]*)\b/);
										if (mName && mName[1]) return mName[1];
									}
									// If the user is still typing the right-side subquery, the closing ')' may not exist yet.
									// Handle `join ... (RightTable | where ...`.
									const openParen = clause.match(/\(\s*([A-Za-z_][\w-]*)\b/);
									if (openParen && openParen[1]) return openParen[1];
									// Otherwise strip common options and take the first identifier.
									const afterOp = clause.replace(/^(join|lookup)\b/i, '').trim();
									const withoutOpts = afterOp
										.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
										.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/ig, ' ')
										.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
										.trim();
									const mName = withoutOpts.match(/^([A-Za-z_][\w-]*)\b/);
									return mName && mName[1] ? mName[1] : null;
								} catch {
									return null;
								}
							};

							let __kustoActiveTabularContext = null;
							const inferActiveTable = (text) => {
								__kustoActiveTabularContext = null;
								// Prefer last explicit join/lookup/from target.
								try {
									const refs = [];
									for (const m of String(text || '').matchAll(/\b(join|lookup|from)\b/gi)) {
										const kw = String(m[1] || '').toLowerCase();
										const idx = (typeof m.index === 'number') ? m.index : -1;
										if (idx < 0) continue;
										// Limit parsing to the rest of the current line/stage.
										let end = String(text || '').indexOf('\n', idx);
										if (end < 0) end = String(text || '').length;
										const seg = String(text || '').slice(idx, end);
										if (kw === 'from') {
											// from cluster('X').database('Y').T
											const fq = __kustoParseFullyQualifiedTableExpr(seg);
											if (fq) {
												refs.push(fq.table);
												continue;
											}
											const mm = seg.match(/^from\s+([A-Za-z_][\w-]*)\b/i);
											if (mm && mm[1]) refs.push(mm[1]);
											continue;
										}
										const right = __kustoExtractJoinOrLookupRightTable(seg);
										if (right) refs.push(right);
									}
									if (refs.length > 0) return refs[refs.length - 1];
								} catch { /* ignore */ }

								// Handle `let Name = <tabular>` by looking at the RHS after '='.
								try {
									const mLet = String(text || '').match(/^\s*let\s+[A-Za-z_][\w-]*\s*=([\s\S]*)$/i);
									if (mLet && mLet[1]) {
										let rhs = String(mLet[1]).trim();
										rhs = rhs.replace(/^\(\s*/g, '').trim();
										const src = rhs.match(/^([A-Za-z_][\w-]*)\b/);
										if (src && src[1]) {
											return src[1];
										}
									}
								} catch { /* ignore */ }

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
									// Fully-qualified source line.
									const fq = __kustoParseFullyQualifiedTableExpr(line);
									if (fq) {
										__kustoActiveTabularContext = { kind: 'fq', cluster: fq.cluster, database: fq.database, table: fq.table };
										return fq.table;
									}
									const m = line.match(/^([A-Za-z_][\w-]*)\b/);
									if (m) {
										return m[1];
									}
								}
								return null;
							};

							let activeTable = inferActiveTable(statementTextUpToCursor);

							const __kustoFindSchemaTableName = (name) => {
								if (!name || !schema || !Array.isArray(schema.tables)) return null;
								const lower = String(name).toLowerCase();
								for (const t of schema.tables) {
									if (String(t).toLowerCase() === lower) return t;
								}
								return null;
							};

							// Normalize to the canonical schema table name when possible.
							try {
								activeTable = __kustoFindSchemaTableName(activeTable) || activeTable;
							} catch { /* ignore */ }

							const __kustoSplitCommaList = (s) => {
								if (!s) return [];
								return String(s)
									.split(',')
									.map(x => x.trim())
									.filter(Boolean);
							};

							const __kustoComputeAvailableColumnsAtOffset = async (fullText, offset) => {
								const columnsByTable = __kustoGetColumnsByTable(schema);
								if (!schema || !columnsByTable) return null;

								const __kustoParseJoinKind = (stageText) => {
									try {
										const m = String(stageText || '').match(/\bkind\s*=\s*([A-Za-z_][\w-]*)\b/i);
										return m && m[1] ? String(m[1]).toLowerCase() : '';
									} catch { return ''; }
								};

								const __kustoJoinOutputMode = (kindLower) => {
									const k = String(kindLower || '').toLowerCase();
									if (!k) return 'union';
									if (k.includes('leftanti') || k.includes('leftsemi') || k === 'anti' || k === 'semi') return 'left';
									if (k.includes('rightanti') || k.includes('rightsemi')) return 'right';
									return 'union';
								};

								const __kustoExtractFirstParenGroup = (text) => {
									// Returns the content of the first (...) group at top-level.
									try {
										const s = String(text || '');
										let depth = 0;
										let inSingle = false;
										let inDouble = false;
										for (let i = 0; i < s.length; i++) {
											const ch = s[i];
											const next = s[i + 1];
											if (inSingle) {
												if (ch === "'") {
													if (next === "'") { i++; continue; }
													inSingle = false;
												}
												continue;
											}
											if (inDouble) {
												if (ch === '\\') { i++; continue; }
												if (ch === '"') inDouble = false;
												continue;
											}
											if (ch === "'") { inSingle = true; continue; }
											if (ch === '"') { inDouble = true; continue; }
											if (ch === '(') {
												if (depth === 0) {
													const start = i + 1;
													depth = 1;
													for (let j = start; j < s.length; j++) {
														const cj = s[j];
														const nj = s[j + 1];
														if (inSingle) {
															if (cj === "'") {
																if (nj === "'") { j++; continue; }
																inSingle = false;
															}
															continue;
														}
														if (inDouble) {
															if (cj === '\\') { j++; continue; }
															if (cj === '"') inDouble = false;
															continue;
														}
														if (cj === "'") { inSingle = true; continue; }
														if (cj === '"') { inDouble = true; continue; }
														if (cj === '(') depth++;
														else if (cj === ')') {
															depth--;
															if (depth === 0) {
																return s.slice(start, j);
															}
														}
													}
													return null;
												}
												depth++;
											}
										}
									} catch { return null; }
									return null;
								};

								// Build a best-effort map of let-name -> rhs-text in scope (up to cursor).
								const __kustoLetRhsByLower = new Map();
								try {
									const prefix = String(fullText || '').slice(0, Math.max(0, offset));
									const stmts = (typeof __kustoSplitTopLevelStatements === 'function')
										? __kustoSplitTopLevelStatements(prefix)
										: [{ startOffset: 0, text: prefix }];
									for (const st of (stmts || [])) {
										const t = String(st && st.text ? st.text : '').trim();
										if (!/^let\s+/i.test(t)) continue;
										const m = String(st.text || '').match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)\s*$/i);
										if (!m || !m[1] || !m[2]) continue;
										const nameLower = String(m[1]).toLowerCase();
										const rhs = String(m[2] || '').replace(/;\s*$/g, '').trim();
										__kustoLetRhsByLower.set(nameLower, rhs);
									}
								} catch { /* ignore */ }

								const __kustoLetColsMemo = new Map();
								const __kustoLetInProgress = new Set();

								const __kustoInferSourceFromText = (text) => {
									const lines = String(text || '').split(/\r?\n/);
									for (const raw of lines) {
										const line = String(raw || '').trim();
										if (!line) continue;
										if (line.startsWith('|') || line.startsWith('.') || line.startsWith('//')) continue;
										const fq = __kustoParseFullyQualifiedTableExpr(line);
										if (fq) return { kind: 'fq', cluster: fq.cluster, database: fq.database, table: fq.table };
										const m = line.match(/^([A-Za-z_][\w-]*)\b/);
										if (m && m[1]) return { kind: 'ident', name: m[1] };
									}
									return null;
								};

								const __kustoComputeColumnsForPipelineText = async (pipelineText) => {
									const parts = __kustoSplitPipelineStagesDeep(String(pipelineText || ''));
									if (!parts || parts.length === 0) return null;
									const src = __kustoInferSourceFromText(parts[0]);
									let cols = null;
									if (src && src.kind === 'fq') {
										const otherSchema = await __kustoEnsureSchemaForClusterDb(src.cluster, src.database);
											const otherColsByTable = __kustoGetColumnsByTable(otherSchema);
											if (otherColsByTable && otherColsByTable[src.table]) {
												cols = Array.from(otherColsByTable[src.table]);
											}
									} else if (src && src.kind === 'ident') {
										const t = __kustoFindSchemaTableName(src.name);
											if (t && columnsByTable && columnsByTable[t]) {
												cols = Array.from(columnsByTable[t]);
										} else {
										const lower = String(src.name).toLowerCase();
										cols = await __kustoComputeLetColumns(lower);
										if (cols) cols = Array.from(cols);
									}
									}
									if (!cols) return null;

									for (let i = 1; i < parts.length; i++) {
										const stage = String(parts[i] || '').trim();
										if (!stage) continue;
										const lower = stage.toLowerCase();
										if (/^where\b/i.test(lower)) continue;
										if (/^(take|top|limit)\b/i.test(lower)) continue;
										if (/^order\s+by\b/i.test(lower) || /^sort\s+by\b/i.test(lower)) continue;
											if (lower === 'count' || lower.startsWith('count ')) {
												cols = ['Count'];
												continue;
											}
											if (/^union\b/i.test(lower)) {
												// union outputs the union of columns across sources (best-effort).
												try {
													let unionBody = stage.replace(/^union\b/i, '').trim();
													unionBody = unionBody
														.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
														.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
														.replace(/\bisfuzzy\s*=\s*(true|false)\b/ig, ' ')
														.trim();
													const set = new Set(cols);
													for (const item of __kustoSplitCommaList(unionBody)) {
														const expr = String(item || '').trim();
														if (!expr) continue;
														const otherCols = await __kustoComputeColumnsForPipelineText(expr.replace(/^\(\s*/g, '').replace(/\s*\)$/g, '').trim());
														if (!otherCols) continue;
														for (const c of otherCols) set.add(c);
													}
													cols = Array.from(set);
												} catch { /* ignore */ }
												continue;
											}
										if (/^distinct\b/i.test(lower)) {
											const afterKw = stage.replace(/^distinct\s+/i, '');
											const nextCols = [];
											for (const item of __kustoSplitCommaList(afterKw)) {
												const mId = item.match(/^([A-Za-z_][\w]*)\b/);
												if (mId && mId[1]) nextCols.push(mId[1]);
											}
											if (nextCols.length) cols = nextCols;
											continue;
										}
											if (/^project-rename\b/i.test(lower)) {
												const afterKw = stage.replace(/^project-rename\b/i, '').trim();
												for (const item of __kustoSplitCommaList(afterKw)) {
													const m = item.match(/^([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\b/);
													if (m && m[1] && m[2]) {
														cols = cols.filter(c => c !== m[2]);
														if (!cols.includes(m[1])) cols.push(m[1]);
													}
												}
												continue;
											}
											if (/^project-away\b/i.test(lower)) {
												const afterKw = stage.replace(/^project-away\b/i, '').trim();
												const remove = new Set();
												for (const item of __kustoSplitCommaList(afterKw)) {
													const mId = item.match(/^([A-Za-z_][\w]*)\b/);
													if (mId && mId[1]) remove.add(mId[1]);
												}
												if (remove.size) cols = cols.filter(c => !remove.has(c));
												continue;
											}
											if (/^project-keep\b/i.test(lower)) {
												const afterKw = stage.replace(/^project-keep\b/i, '').trim();
												const keep = [];
												for (const item of __kustoSplitCommaList(afterKw)) {
													const mId = item.match(/^([A-Za-z_][\w]*)\b/);
													if (mId && mId[1]) keep.push(mId[1]);
												}
												if (keep.length) cols = keep;
												continue;
											}
										if (/^project\b/i.test(lower)) {
											const afterKw = stage.replace(/^project\b/i, '').trim();
											const nextCols = [];
											for (const item of __kustoSplitCommaList(afterKw)) {
												const mAssign = item.match(/^([A-Za-z_][\w]*)\s*=/);
												if (mAssign && mAssign[1]) { nextCols.push(mAssign[1]); continue; }
												const mId = item.match(/^([A-Za-z_][\w]*)\b/);
												if (mId && mId[1]) nextCols.push(mId[1]);
											}
											if (nextCols.length) cols = nextCols;
											continue;
										}
											if (/^extend\b/i.test(lower)) {
												try {
													const set = new Set(cols);
													const body = stage.replace(/^extend\b/i, '');
													for (const m of body.matchAll(/\b([A-Za-z_][\w]*)\s*=/g)) {
														if (m && m[1]) set.add(String(m[1]));
													}
													cols = Array.from(set);
												} catch { /* ignore */ }
												continue;
											}
											if (/^parse(-where)?\b/i.test(lower)) {
												// parse/parse-where extends the table with extracted columns.
												try {
													const set = new Set(cols);
													const withIdx = stage.toLowerCase().indexOf(' with ');
													if (withIdx >= 0) {
														const body = stage.slice(withIdx + 6);
														for (const m of body.matchAll(/(?:"[^"]*"|'[^']*'|\*)\s*([A-Za-z_][\w]*)\s*(?::\s*[A-Za-z_][\w]*)?/g)) {
															const name = m && m[1] ? String(m[1]) : '';
															if (!name) continue;
															const nl = name.toLowerCase();
															if (nl === 'kind' || nl === 'flags' || nl === 'with') continue;
															set.add(name);
														}
													}
													cols = Array.from(set);
												} catch { /* ignore */ }
												continue;
											}
											if (/^mv-expand\b/i.test(lower)) {
												try {
													const set = new Set(cols);
													const body = stage.replace(/^mv-expand\s*/i, '');
													const body2 = body.split(/\blimit\b/i)[0] || body;
													for (const part of __kustoSplitCommaList(body2)) {
														const mAssign = part.match(/^([A-Za-z_][\w]*)\s*=/);
														if (mAssign && mAssign[1]) set.add(mAssign[1]);
													}
													cols = Array.from(set);
												} catch { /* ignore */ }
												continue;
											}
											if (/^make-series\b/i.test(lower)) {
												// make-series output: axis column + assigned series columns + by columns (best-effort).
												try {
													const next = new Set();
													const mOn = stage.match(/\bon\s+([A-Za-z_][\w]*)\b/i);
													if (mOn && mOn[1]) next.add(mOn[1]);
													const preOn = stage.split(/\bon\b/i)[0] || stage;
													for (const m of preOn.matchAll(/\b([A-Za-z_][\w]*)\s*=/g)) {
														if (m && m[1]) next.add(String(m[1]));
													}
													const mBy = stage.match(/\bby\b([\s\S]*)$/i);
													if (mBy && mBy[1]) {
														for (const item of __kustoSplitCommaList(mBy[1])) {
															const mId = item.match(/^([A-Za-z_][\w]*)\b/);
															if (mId && mId[1]) next.add(mId[1]);
														}
													}
													if (next.size > 0) cols = Array.from(next);
												} catch { /* ignore */ }
												continue;
											}
											if (/^summarize\b/i.test(lower)) {
												// summarize output columns are aggregates + group-by keys.
												const summarizeBody = stage.replace(/^summarize\b/i, '').trim();
												const parts2 = summarizeBody.split(/\bby\b/i);
												const aggPart = parts2[0] || '';
												const byPart = parts2.length > 1 ? parts2.slice(1).join('by') : '';

												const nextCols = [];
												for (const item of __kustoSplitCommaList(byPart)) {
													const mId = item.match(/^([A-Za-z_][\w]*)\b/);
													if (mId && mId[1]) nextCols.push(mId[1]);
												}
												for (const item of __kustoSplitCommaList(aggPart)) {
													const mAssign = item.match(/^([A-Za-z_][\w]*)\s*=/);
													if (mAssign && mAssign[1]) nextCols.push(mAssign[1]);
												}
												if (nextCols.length) cols = nextCols;
												continue;
											}
										if (/^(join|lookup)\b/i.test(lower)) {
											const kind = __kustoParseJoinKind(stage);
											const mode = __kustoJoinOutputMode(kind);
											let rightExpr = __kustoExtractFirstParenGroup(stage);
											if (!rightExpr) {
												let afterOp = String(stage).replace(/^(join|lookup)\b/i, '').trim();
												afterOp = afterOp
													.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
													.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/ig, ' ')
													.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
													.trim();
												const mName = afterOp.match(/^([A-Za-z_][\w-]*)\b/);
												rightExpr = (mName && mName[1]) ? mName[1] : null;
											}
											const rightCols = rightExpr ? await __kustoComputeColumnsForPipelineText(rightExpr) : null;
											if (mode === 'right' && rightCols) { cols = Array.from(rightCols); continue; }
											if (mode === 'left') { continue; }
											if (rightCols) {
												const set = new Set(cols);
												for (const c of rightCols) if (!set.has(c)) set.add(c);
												cols = Array.from(set);
											}
											continue;
										}
									}

									return cols;
								};

								const __kustoComputeLetColumns = async (letNameLower) => {
									const key = String(letNameLower || '').toLowerCase();
									if (!key) return null;
									if (__kustoLetColsMemo.has(key)) return __kustoLetColsMemo.get(key);
									if (__kustoLetInProgress.has(key)) return null;
									const rhs = __kustoLetRhsByLower.get(key);
									if (!rhs) return null;
									__kustoLetInProgress.add(key);
									try {
										const cols = await __kustoComputeColumnsForPipelineText(rhs);
										__kustoLetColsMemo.set(key, cols);
										return cols;
									} finally {
										__kustoLetInProgress.delete(key);
									}
								};

								const __kustoBuildLetTabularResolver = (text) => {
									const tablesByLower = {};
									try {
										for (const t of (schema && Array.isArray(schema.tables) ? schema.tables : [])) {
											tablesByLower[String(t).toLowerCase()] = String(t);
										}
									} catch { /* ignore */ }

									const letSources = {};
									const extractSourceLower = (rhsText) => {
										const rhs = String(rhsText || '').trim();
										if (!rhs) return null;
										try {
											const fq = __kustoParseFullyQualifiedTableExpr(rhs);
											if (fq) {
												return { tableLower: String(fq.table).toLowerCase(), cluster: fq.cluster, database: fq.database, table: fq.table };
											}
										} catch { /* ignore */ }
										try {
											const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
											if (m && m[1]) return { tableLower: String(m[1]).toLowerCase(), cluster: null, database: null, table: String(m[1]) };
										} catch { /* ignore */ }
										try {
											const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
											if (m && m[1]) return { tableLower: String(m[1]).toLowerCase(), cluster: null, database: null, table: String(m[1]) };
										} catch { /* ignore */ }
										try {
											const m = rhs.replace(/^\(\s*/g, '').trim().match(/^([A-Za-z_][\w-]*)\b/);
											return (m && m[1]) ? { tableLower: String(m[1]).toLowerCase(), cluster: null, database: null, table: String(m[1]) } : null;
										} catch { return null; }
									};
									try {
										const lines = String(text || '').split(/\r?\n/);
										for (let i = 0; i < lines.length; i++) {
											const trimmed = lines[i].trim();
											if (!/^let\s+/i.test(trimmed)) continue;
											let stmt = lines[i];
											while (i + 1 < lines.length && stmt.indexOf(';') === -1) {
												i++;
												stmt += '\n' + lines[i];
											}
											const m = stmt.match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)(;|$)/i);
											if (!m || !m[1] || !m[2]) continue;
											const letNameLower = String(m[1]).toLowerCase();
											let rhs = String(m[2]).trim();
											const src = extractSourceLower(rhs);
											if (!src) continue;
											letSources[letNameLower] = src;
										}
									} catch { /* ignore */ }

									const resolveToContext = async (name) => {
										let cur = String(name || '').toLowerCase();
										for (let depth = 0; depth < 8; depth++) {
											if (tablesByLower[cur]) {
												return { schema, table: tablesByLower[cur] };
											}
											const src = letSources[cur];
											if (!src) return null;
											// src can carry cross-cluster/db context
											if (src && typeof src === 'object' && src.tableLower) {
												if (src.cluster && src.database) {
													const otherSchema = await __kustoEnsureSchemaForClusterDb(src.cluster, src.database);
															if (otherSchema && __kustoGetColumnsByTable(otherSchema)) {
														// Best-effort: keep original case as written in query
														return { schema: otherSchema, table: src.table || String(src.tableLower) };
													}
												}
												cur = String(src.tableLower);
												continue;
											}
											cur = String(src).toLowerCase();
										}
										return null;
									};
									return resolveToContext;
								};

								const resolveTabularNameToContext = __kustoBuildLetTabularResolver(fullText);
								const __kustoResolveToSchemaTableName = (name) => __kustoFindSchemaTableName(name);
								const statementStart = __kustoGetStatementStartAtOffset(fullText, offset);
								const before = String(fullText || '').slice(statementStart, Math.max(statementStart, Math.max(0, offset)));
								let resolvedCtx = null;
								// If the statement source is a fully-qualified cluster/database expression, prefer that schema.
								const fq = __kustoParseFullyQualifiedTableExpr(before);
								if (fq) {
									const otherSchema = await __kustoEnsureSchemaForClusterDb(fq.cluster, fq.database);
									if (otherSchema) {
										resolvedCtx = { schema: otherSchema, table: fq.table };
									}
								}
								if (!resolvedCtx) {
									// Resolve normal table name or let-bound tabular var.
									try {
										const srcName = inferActiveTable(before);
										if (srcName && resolveTabularNameToContext) {
											resolvedCtx = await resolveTabularNameToContext(srcName);
										}
									} catch { /* ignore */ }
								}
								if (!resolvedCtx) {
									// Final fallback: current schema + canonical table name
									const t = __kustoResolveToSchemaTableName(inferActiveTable(before));
									if (t) resolvedCtx = { schema, table: t };
								}
								if (!resolvedCtx && schema.tables && schema.tables.length === 1) {
									resolvedCtx = { schema, table: schema.tables[0] };
								}
								const activeSchema = resolvedCtx ? resolvedCtx.schema : schema;
								let table = resolvedCtx ? resolvedCtx.table : null;
								const activeColumnsByTable = __kustoGetColumnsByTable(activeSchema);
								let cols = (table && activeColumnsByTable && activeColumnsByTable[table])
									? Array.from(activeColumnsByTable[table])
									: null;
								// If the active source is a let-bound tabular variable, override columns with its projected shape.
								try {
									const srcName = inferActiveTable(before);
									const letCols = srcName ? await __kustoComputeLetColumns(String(srcName).toLowerCase()) : null;
									if (letCols && Array.isArray(letCols) && letCols.length) {
										cols = Array.from(letCols);
									}
								} catch { /* ignore */ }
								if (!cols) {
									return null;
								}

								const __kustoSplitPipelineStages = __kustoSplitPipelineStagesDeep;

								// Apply very lightweight pipeline transforms up to (but not including) the stage the cursor is currently in.
								// This keeps completions inside `| project ...` / `| summarize ...` using input columns.
								const parts = __kustoSplitPipelineStages(before);
								for (let i = 1; i < Math.max(1, parts.length - 1); i++) {
									const stage = parts[i].trim();
									if (!stage) continue;
									const lower = stage.toLowerCase();

															if (/^where\b/i.test(lower)) {
										continue;
									}
															if (/^(take|top|limit)\b/i.test(lower)) {
										continue;
									}

									if (lower === 'count' || lower.startsWith('count ')) {
										// `count` operator returns a single column (best-effort name).
										cols = ['Count'];
										continue;
									}
															if (/^order\s+by\b/i.test(lower) || /^sort\s+by\b/i.test(lower)) {
										continue;
									}

															if (/^union\b/i.test(lower)) {
										// union T1, T2 ...  => available columns are the union of referenced tables + current columns
																const unionBody = stage.replace(/^union\b/i, '').trim();
										const set = new Set(cols);
										const schemaColumnsByTable = __kustoGetColumnsByTable(schema);
										for (const m of unionBody.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
											const t = __kustoResolveToSchemaTableName(m[1]);
											if (t && schemaColumnsByTable && schemaColumnsByTable[t]) {
												for (const c of schemaColumnsByTable[t]) set.add(c);
											}
										}
										cols = Array.from(set);
										continue;
									}

																		if (/^(join|lookup)\b/i.test(lower)) {
															const kind = __kustoParseJoinKind(stage);
															const mode = __kustoJoinOutputMode(kind);
															let rightExpr = __kustoExtractFirstParenGroup(stage);
															if (!rightExpr) {
																let afterOp = String(stage).replace(/^(join|lookup)\b/i, '').trim();
																afterOp = afterOp
																	.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
																	.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/ig, ' ')
																	.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
																	.trim();
																const mName = afterOp.match(/^([A-Za-z_][\w-]*)\b/);
																rightExpr = (mName && mName[1]) ? mName[1] : null;
															}
															const rightCols = rightExpr ? await __kustoComputeColumnsForPipelineText(rightExpr) : null;
															if (mode === 'right' && rightCols) {
																cols = Array.from(rightCols);
																continue;
															}
															if (mode === 'left') {
																continue;
															}
															if (rightCols) {
																const set = new Set(cols);
																for (const c of rightCols) if (!set.has(c)) set.add(c);
																cols = Array.from(set);
															}
															continue;
														}

										if (/^(extend|project-reorder|project-smart)\b/i.test(lower)) {
											const afterKw = stage.replace(/^\w[\w-]*\b/i, '').trim();
										for (const item of __kustoSplitCommaList(afterKw)) {
											const m = item.match(/^([A-Za-z_][\w]*)\s*=/);
											if (m && m[1] && !cols.includes(m[1])) {
												cols.push(m[1]);
											}
										}
										continue;
									}
										if (/^project-away\b/i.test(lower)) {
											const afterKw = stage.replace(/^project-away\b/i, '').trim();
										const toRemove = new Set();
										for (const item of __kustoSplitCommaList(afterKw)) {
											const m = item.match(/^([A-Za-z_][\w]*)\b/);
											if (m && m[1]) toRemove.add(m[1]);
										}
										cols = cols.filter(c => !toRemove.has(c));
										continue;
									}
										if (/^project-keep\b/i.test(lower)) {
											const afterKw = stage.replace(/^project-keep\b/i, '').trim();
										const keep = new Set();
										for (const item of __kustoSplitCommaList(afterKw)) {
											const m = item.match(/^([A-Za-z_][\w]*)\b/);
											if (m && m[1]) keep.add(m[1]);
										}
										cols = cols.filter(c => keep.has(c));
										continue;
									}
										if (/^project-rename\b/i.test(lower)) {
											const afterKw = stage.replace(/^project-rename\b/i, '').trim();
										for (const item of __kustoSplitCommaList(afterKw)) {
											const m = item.match(/^([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\b/);
											if (m && m[1] && m[2]) {
												cols = cols.filter(c => c !== m[2]);
												if (!cols.includes(m[1])) cols.push(m[1]);
											}
										}
										continue;
									}

										if (/^project\b/i.test(lower)) {
											const afterKw = stage.replace(/^project\b/i, '').trim();
										const nextCols = [];
										for (const item of __kustoSplitCommaList(afterKw)) {
											const mAssign = item.match(/^([A-Za-z_][\w]*)\s*=/);
											if (mAssign && mAssign[1]) {
												nextCols.push(mAssign[1]);
												continue;
											}
											const mId = item.match(/^([A-Za-z_][\w]*)\b/);
											if (mId && mId[1]) nextCols.push(mId[1]);
										}
										if (nextCols.length > 0) cols = nextCols;
										continue;
									}

										if (/^distinct\b/i.test(lower)) {
											const afterKw = stage.replace(/^distinct\b/i, '').trim();
										const nextCols = [];
										for (const item of __kustoSplitCommaList(afterKw)) {
											const mId = item.match(/^([A-Za-z_][\w]*)\b/);
											if (mId && mId[1]) nextCols.push(mId[1]);
										}
										if (nextCols.length > 0) cols = nextCols;
										continue;
									}

										if (/^parse(-where)?\b/i.test(lower)) {
										// parse/parse-where extends the table with extracted columns.
										try {
											const set = new Set(cols);
											// Heuristic: after `with`, patterns often include string constants followed by a column name.
											const withIdx = stage.toLowerCase().indexOf(' with ');
											if (withIdx >= 0) {
												const body = stage.slice(withIdx + 6);
												for (const m of body.matchAll(/(?:"[^"]*"|'[^']*'|\*)\s*([A-Za-z_][\w]*)\s*(?::\s*[A-Za-z_][\w]*)?/g)) {
													const name = m && m[1] ? String(m[1]) : '';
													if (!name) continue;
													const nl = name.toLowerCase();
													if (nl === 'kind' || nl === 'flags' || nl === 'with') continue;
													set.add(name);
												}
											}
											cols = Array.from(set);
										} catch { /* ignore */ }
										continue;
									}

										if (/^mv-expand\b/i.test(lower)) {
										// mv-expand can introduce a new column name when using `Name = ArrayExpression`.
										try {
											const set = new Set(cols);
											const body = stage.replace(/^mv-expand\s*/i, '');
											const body2 = body.split(/\blimit\b/i)[0] || body;
											for (const part of __kustoSplitCommaList(body2)) {
												const mAssign = part.match(/^([A-Za-z_][\w]*)\s*=/);
												if (mAssign && mAssign[1]) set.add(mAssign[1]);
											}
											cols = Array.from(set);
										} catch { /* ignore */ }
										continue;
									}

										if (/^make-series\b/i.test(lower)) {
										// make-series output: axis column + assigned series columns + by columns (best-effort).
										try {
											const next = new Set();
											// Axis: `on AxisColumn`
											const mOn = stage.match(/\bon\s+([A-Za-z_][\w]*)\b/i);
											if (mOn && mOn[1]) next.add(mOn[1]);
											// Assigned series columns: `Name = Aggregation`
											const preOn = stage.split(/\bon\b/i)[0] || stage;
											for (const m of preOn.matchAll(/\b([A-Za-z_][\w]*)\s*=/g)) {
												if (m && m[1]) next.add(String(m[1]));
											}
											// by columns
											const mBy = stage.match(/\bby\b([\s\S]*)$/i);
											if (mBy && mBy[1]) {
												for (const item of __kustoSplitCommaList(mBy[1])) {
													const mId = item.match(/^([A-Za-z_][\w]*)\b/);
													if (mId && mId[1]) next.add(mId[1]);
												}
											}
											if (next.size > 0) cols = Array.from(next);
										} catch { /* ignore */ }
										continue;
									}

										if (/^summarize\b/i.test(lower)) {
											const summarizeBody = stage.replace(/^summarize\b/i, '').trim();
										const parts2 = summarizeBody.split(/\bby\b/i);
										const aggPart = parts2[0] || '';
										const byPart = parts2.length > 1 ? parts2.slice(1).join('by') : '';

										const nextCols = [];
										for (const item of __kustoSplitCommaList(byPart)) {
											const mId = item.match(/^([A-Za-z_][\w]*)\b/);
											if (mId && mId[1]) nextCols.push(mId[1]);
										}
										for (const item of __kustoSplitCommaList(aggPart)) {
											const mAssign = item.match(/^([A-Za-z_][\w]*)\s*=/);
											if (mAssign && mAssign[1]) nextCols.push(mAssign[1]);
										}
										if (nextCols.length > 0) cols = nextCols;
										continue;
									}
								}

								return cols;
							};


							// For schema completions, use the full token/word range so selecting an item replaces the rest of the word.
							const range = replaceRange;

							// In multi-statement scripts, earlier `let` variables remain in scope. Collect them once.
							let __kustoLetNamesByLower = null;
							try {
								const prefix = String(textUpToCursor || '');
								const toks = __kustoScanIdentifiers(prefix);
								const byLower = new Map();
								for (let i = 0; i < toks.length; i++) {
									const t = toks[i];
									if (!t || t.type !== 'ident' || t.depth !== 0) continue;
									if (String(t.value || '').toLowerCase() !== 'let') continue;
									let nameTok = null;
									for (let j = i + 1; j < toks.length; j++) {
										const tt = toks[j];
										if (!tt || tt.depth !== 0) continue;
										if (tt.type === 'ident') { nameTok = tt; break; }
										if (tt.type === 'pipe') break;
									}
									if (!nameTok || !nameTok.value) continue;
									const after = prefix.slice(nameTok.endOffset, Math.min(prefix.length, nameTok.endOffset + 64));
									if (!/^\s*=/.test(after)) continue;
									byLower.set(String(nameTok.value).toLowerCase(), String(nameTok.value));
								}
								// Fallback: regex-based extraction (more tolerant of tokenization edge cases).
								try {
									for (const m of prefix.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
										if (!m || !m[2]) continue;
										const original = String(m[2]);
										const lower = original.toLowerCase();
										if (!byLower.has(lower)) byLower.set(lower, original);
									}
								} catch { /* ignore */ }
								__kustoLetNamesByLower = byLower;
							} catch {
								__kustoLetNamesByLower = null;
							}

							// Columns first when in '| where' / '| project' etc.
							if (shouldSuggestColumnsOrJoinOn) {
								let columns = null;
								try {
									columns = await __kustoComputeAvailableColumnsAtOffset(model.getValue(), model.getOffsetAt(position));
								} catch {
									columns = null;
								}

								// If inside `join/lookup ... on`, union left + right columns.
								if (__kustoIsJoinOrLookupOnContext) {
									try {
										const stmt = String(statementTextUpToCursor || '');
										const stage = __kustoGetLastTopLevelStageText(stmt, stmt.length);
										let rightName = null;
										const paren = stage.match(/\(([^)]*)\)/);
										if (paren && paren[1]) {
											const mName = String(paren[1]).trim().match(/^([A-Za-z_][\w-]*)\b/);
											if (mName && mName[1]) rightName = mName[1];
										}
																if (!rightName) {
																	// Strip common join/lookup options so we don't accidentally treat 'kind' as a table.
																	const afterOp = String(stage)
																		.replace(/^(join|lookup)\b/i, '')
																		.trim();
																	const withoutOpts = afterOp
																		.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
																		.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/ig, ' ')
																		.trim();
																	const mName = withoutOpts.match(/^([A-Za-z_][\w-]*)\b/);
																	if (mName && mName[1]) rightName = mName[1];
																}
										const resolvedRight = __kustoResolveToSchemaTableNameForCompletion(rightName);
										const columnsByTable = __kustoGetColumnsByTable(schema);
										const rightCols = (resolvedRight && columnsByTable && columnsByTable[resolvedRight]) ? columnsByTable[resolvedRight] : null;
										const set = new Set(Array.isArray(columns) ? columns : []);
										if (rightCols) {
											for (const c of rightCols) set.add(c);
										}
										columns = Array.from(set);
									} catch { /* ignore */ }
								}
								if (!columns && activeTable) {
									const resolved = __kustoFindSchemaTableName(activeTable);
									const key = resolved || activeTable;
										if (columnsByTable && columnsByTable[key]) {
											columns = columnsByTable[key];
										activeTable = key;
									}
								}
									if (!columns && schema.tables && schema.tables.length === 1 && columnsByTable && columnsByTable[schema.tables[0]]) {
									activeTable = schema.tables[0];
										columns = columnsByTable[activeTable];
								}

								if (columns) {
									for (const c of columns) {
										pushSuggestion({
											label: c,
											kind: monaco.languages.CompletionItemKind.Field,
											insertText: c,
											filterText: (__kustoIsInFunctionArgs && typedRaw) ? typedRaw : undefined,
											sortText: '0_' + String(c).toLowerCase(),
											range
										}, 'col:' + c);
									}
								}

									// Suggest `let` variables alongside columns in expression contexts.
									try {
										if (__kustoLetNamesByLower) {
											for (const [nl, name] of __kustoLetNamesByLower.entries()) {
												if (typed && !nl.startsWith(typed)) continue;
												pushSuggestion({
													label: name,
													kind: monaco.languages.CompletionItemKind.Variable,
													insertText: name,
													sortText: '1_' + nl,
													range
											}, 'let:' + nl);
										}
										}
									} catch { /* ignore */ }
							}

							if (shouldSuggestFunctionsOrJoinOn) {
								const __kustoBuildFnInsertText = (fnName, fnDoc) => {
									const args = (fnDoc && Array.isArray(fnDoc.args)) ? fnDoc.args : [];
									const required = args.filter(a => typeof a === 'string' && !a.endsWith('?'));
									if (required.length === 0) {
										return { insertText: fnName + '()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
									}
									const snippetArgs = required.map((a, i) => '${' + (i + 1) + ':' + a + '}').join(', ');
									return { insertText: fnName + '(' + snippetArgs + ')', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
								};

								for (const fn of Object.keys(KUSTO_FUNCTION_DOCS)) {
									if (typed && !fn.toLowerCase().startsWith(typed)) {
										continue;
									}

									const doc = KUSTO_FUNCTION_DOCS[fn];
									const signature = `${fn}(${(doc && doc.args) ? doc.args.join(', ') : ''})`;
									const detail = (doc && doc.returnType) ? `${signature} -> ${doc.returnType}` : signature;
									const documentation = (doc && doc.description)
										? { value: `**${signature}**\n\n${doc.description}` }
										: undefined;

									const insert = __kustoBuildFnInsertText(fn, doc);
									pushSuggestion({
										label: fn,
										kind: monaco.languages.CompletionItemKind.Function,
										detail,
										documentation,
										insertText: insert.insertText,
										insertTextRules: insert.insertTextRules,
										sortText: (shouldSuggestColumnsOrJoinOn ? '2_' : '1_') + fn.toLowerCase(),
										range
									}, 'fn:' + fn);
								}
							}

							// Tables: suggest unless we are in an assignment RHS context.
							// Also suppress table suggestions inside a pipe clause (e.g. after `| where`), since only columns/functions make sense there.
							if (!isAssignmentRhs && !shouldSuggestColumnsOrJoinOn) {
								// At statement start / script end, include `let`-declared tabular variables as table-like suggestions.
								try {
									if (__kustoLetNamesByLower) {
										for (const [nl, name] of __kustoLetNamesByLower.entries()) {
											if (typed && !nl.startsWith(typed)) continue;
											pushSuggestion({
												label: name,
												kind: monaco.languages.CompletionItemKind.Variable,
												insertText: name,
												sortText: '0_' + name,
												range
										}, 'let:' + nl);
									}
								}
								} catch { /* ignore */ }
								for (const t of schema.tables) {
									pushSuggestion({
										label: t,
										kind: monaco.languages.CompletionItemKind.Class,
										insertText: t,
										sortText: (shouldSuggestColumns ? '1' : '0') + t,
										range
									}, 'tbl:' + t);
								}
							}

							return { suggestions };
						}
					};
					__kustoProvideCompletionItemsForDiagnostics = __kustoCompletionProvider.provideCompletionItems;
					monaco.languages.registerCompletionItemProvider('kusto', __kustoCompletionProvider);

					// --- Live diagnostics (markers) + quick fixes ---
					const KUSTO_DIAGNOSTICS_OWNER = 'kusto-diagnostics';

					const __kustoMaskCommentsPreserveLayout = (text) => {
						try {
							const s = String(text || '');
							if (!s) return s;
							const out = new Array(s.length);
							let inLineComment = false;
							let inBlockComment = false;
							let inSingle = false;
							let inDouble = false;
							for (let i = 0; i < s.length; i++) {
								const ch = s[i];
								const next = s[i + 1];

								if (inLineComment) {
									if (ch === '\n') {
										out[i] = ch;
										inLineComment = false;
									} else {
										out[i] = ' ';
									}
									continue;
								}
								if (inBlockComment) {
									if (ch === '*' && next === '/') {
										out[i] = '*';
										out[i + 1] = '/';
										inBlockComment = false;
										i++;
										continue;
									}
									out[i] = (ch === '\n') ? ch : ' ';
									continue;
								}
								if (inSingle) {
									out[i] = ch;
									if (ch === "'") {
										if (next === "'") {
											out[i + 1] = next;
											i++;
											continue;
										}
										inSingle = false;
									}
									continue;
								}
								if (inDouble) {
									out[i] = ch;
									if (ch === '\\') {
										if (next !== undefined) {
											out[i + 1] = next;
											i++;
										}
										continue;
									}
									if (ch === '"') {
										inDouble = false;
									}
									continue;
								}

								if (ch === '/' && next === '/') {
									out[i] = '/';
									out[i + 1] = '/';
									inLineComment = true;
									i++;
									continue;
								}
								if (ch === '/' && next === '*') {
									out[i] = '/';
									out[i + 1] = '*';
									inBlockComment = true;
									i++;
									continue;
								}

								out[i] = ch;
								if (ch === "'") {
									inSingle = true;
								} else if (ch === '"') {
									inDouble = true;
								}
							}
							return out.join('');
						} catch {
							return String(text || '');
						}
					};

					const __kustoFilterMarkersByAutocomplete = async (model, markers) => {
						try {
							if (!model || !Array.isArray(markers) || markers.length === 0) return markers;
							if (typeof __kustoProvideCompletionItemsForDiagnostics !== 'function') return markers;

							const suppressibleCodes = new Set([
								'KW_UNKNOWN_COLUMN',
								'KW_UNKNOWN_TABLE',
								'KW_UNKNOWN_VARIABLE'
							]);

							// Cache completion labels per position so multiple markers on the same token don't recompute.
							const labelsByPos = new Map();
							const getLabelsAt = async (lineNumber, column) => {
								const key = String(lineNumber) + ':' + String(column);
								if (labelsByPos.has(key)) return labelsByPos.get(key);
								let set = null;
								try {
									const res = await __kustoProvideCompletionItemsForDiagnostics(model, { lineNumber, column });
									const suggestions = res && Array.isArray(res.suggestions) ? res.suggestions : [];
									set = new Set();
									for (const s of suggestions) {
										if (!s) continue;
										const label = (typeof s.label === 'string') ? s.label : (s.label && typeof s.label.label === 'string' ? s.label.label : null);
										if (!label) continue;
										set.add(String(label).toLowerCase());
									}
								} catch {
									set = null;
								}
								labelsByPos.set(key, set);
								return set;
							};

							const out = [];
							for (const m of markers) {
								try {
									const code = m && m.code ? String(m.code) : '';
									if (!suppressibleCodes.has(code)) {
										out.push(m);
										continue;
									}
									const range = new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn);
									const tokenText = String(model.getValueInRange(range) || '').trim();
									// Only attempt suppression for identifier-like tokens.
									if (!tokenText || !/^[A-Za-z_][\w-]*$/.test(tokenText)) {
										out.push(m);
										continue;
									}
									const labels = await getLabelsAt(m.endLineNumber, m.endColumn);
									if (labels && labels.has(tokenText.toLowerCase())) {
										// Autocomplete suggests this exact token here; don't show a squiggle.
										continue;
									}
									out.push(m);
								} catch {
									out.push(m);
								}
							}
							return out;
						} catch {
							return markers;
						}
					};

					const __kustoClamp = (n, min, max) => Math.max(min, Math.min(max, n));

					const __kustoSplitTopLevelStatements = (text) => {
						// Split on ';' and blank lines when not inside strings/comments/brackets.
						const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						const out = [];
						let start = 0;
						let depth = 0;
						let inLineComment = false;
						let inBlockComment = false;
						let inSingle = false;
						let inDouble = false;
						for (let i = 0; i < raw.length; i++) {
							const ch = raw[i];
							const next = raw[i + 1];
							if (inLineComment) {
								if (ch === '\n') {
									inLineComment = false;
								} else {
									continue;
								}
							}
							if (inBlockComment) {
								if (ch === '*' && next === '/') {
									inBlockComment = false;
									i++;
								}
								continue;
							}
							if (inSingle) {
								if (ch === "'") {
									// Kusto escape for single quotes: ''
									if (next === "'") {
										i++;
										continue;
									}
									inSingle = false;
								}
								continue;
							}
							if (inDouble) {
								if (ch === '\\') {
									i++;
									continue;
								}
								if (ch === '"') {
									inDouble = false;
								}
								continue;
							}

							// Enter comments
							if (ch === '/' && next === '/') {
								inLineComment = true;
								i++;
								continue;
							}
							if (ch === '/' && next === '*') {
								inBlockComment = true;
								i++;
								continue;
							}

							// Enter strings
							if (ch === "'") {
								inSingle = true;
								continue;
							}
							if (ch === '"') {
								inDouble = true;
								continue;
							}

							// Track bracket depth
							if (ch === '(' || ch === '[' || ch === '{') {
								depth++;
								continue;
							}
							if (ch === ')' || ch === ']' || ch === '}') {
								depth = Math.max(0, depth - 1);
								continue;
							}

							// Statement delimiter
							if (ch === ';' && depth === 0) {
								out.push({ startOffset: start, text: raw.slice(start, i) });
								start = i + 1;
								continue;
							}

							// Blank-line statement separator: treat one-or-more blank lines as a boundary.
							// IMPORTANT: a single newline without a blank line is NOT a separator.
							if (ch === '\n' && depth === 0) {
								let j = i + 1;
								while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
								if (raw[j] === '\n') {
									out.push({ startOffset: start, text: raw.slice(start, i) });
									start = j + 1;
									// Consume any additional blank lines so we don't emit empty statements.
									while (start < raw.length) {
										const end = raw.indexOf('\n', start);
										const lineEnd = end < 0 ? raw.length : end;
										const lineText = raw.slice(start, lineEnd);
										if (/^[ \t]*$/.test(lineText)) {
											if (end < 0) {
												start = raw.length;
												break;
											}
											start = end + 1;
											continue;
										}
										break;
									}
									i = start - 1;
									continue;
								}
							}
						}
						out.push({ startOffset: start, text: raw.slice(start) });
						return out.filter(s => String(s.text || '').trim().length > 0);
					};

					const __kustoSplitPipelineStagesDeep = (text) => {
						// Split at the *shallowest* pipeline depth (not inside strings or comments).
						// This allows pipes inside `let ... { ... }` bodies (depth 1) to behave like top-level pipelines.
						const s = String(text || '');
						const scanMinPipeDepth = () => {
							let depth = 0;
							let inSingle = false;
							let inDouble = false;
							let inLineComment = false;
							let inBlockComment = false;
							let minDepth = Number.POSITIVE_INFINITY;
							for (let i = 0; i < s.length; i++) {
								const ch = s[i];
								const next = s[i + 1];
								if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
								if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
								if (inSingle) {
									if (ch === "'") { if (next === "'") { i++; continue; } inSingle = false; }
									continue;
								}
								if (inDouble) {
									if (ch === '\\') { i++; continue; }
									if (ch === '"') inDouble = false;
									continue;
								}
								if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
								if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
								if (ch === "'") { inSingle = true; continue; }
								if (ch === '"') { inDouble = true; continue; }
								if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
								if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
								if (ch === '|') { minDepth = Math.min(minDepth, depth); continue; }
							}
							return Number.isFinite(minDepth) ? minDepth : 0;
						};
						const targetDepth = scanMinPipeDepth();
						const parts = [];
						let start = 0;
						let depth = 0;
						let inSingle = false;
						let inDouble = false;
						let inLineComment = false;
						let inBlockComment = false;
						for (let i = 0; i < s.length; i++) {
							const ch = s[i];
							const next = s[i + 1];
							if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
							if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
							if (inSingle) {
								if (ch === "'") { if (next === "'") { i++; continue; } inSingle = false; }
								continue;
							}
							if (inDouble) {
								if (ch === '\\') { i++; continue; }
								if (ch === '"') inDouble = false;
								continue;
							}
							if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
							if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
							if (ch === "'") { inSingle = true; continue; }
							if (ch === '"') { inDouble = true; continue; }
							if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
							if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
							if (ch === '|' && depth === targetDepth) {
								parts.push(s.slice(start, i));
								start = i + 1;
							}
						}
						parts.push(s.slice(start));
						return parts;
					};

					const __kustoFindLastTopLevelPipeBeforeOffset = (text, offset) => {
						// Returns the offset of the last top-level '|' before `offset` (exclusive), or -1.
						try {
							const s = String(text || '');
							const end = Math.max(0, Math.min(s.length, Number(offset) || 0));
							let last = -1;
							let depth = 0;
							let inLineComment = false;
							let inBlockComment = false;
							let inSingle = false;
							let inDouble = false;
							for (let i = 0; i < end; i++) {
								const ch = s[i];
								const next = s[i + 1];
								if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
								if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
								if (inSingle) {
									if (ch === "'") {
										if (next === "'") { i++; continue; }
										inSingle = false;
									}
									continue;
								}
								if (inDouble) { if (ch === '\\') { i++; continue; } if (ch === '"') inDouble = false; continue; }
								if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
								if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
								if (ch === "'") { inSingle = true; continue; }
								if (ch === '"') { inDouble = true; continue; }
								if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
								if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
								if (ch === '|' && depth === 0) { last = i; continue; }
							}
							return last;
						} catch {
							return -1;
						}
					};

					const __kustoGetActivePipeStageInfoBeforeOffset = (stmtText, offsetInStmt) => {
						try {
							const s = String(stmtText || '');
							const pipeIdx = __kustoFindLastTopLevelPipeBeforeOffset(s, offsetInStmt);
							if (pipeIdx < 0) return null;
							const lineAfterPipe = s.slice(pipeIdx + 1).split('\n')[0] || '';
							const after = String(lineAfterPipe).trim();
							if (!after) return null;
							const lower = after.toLowerCase();
							let key = null;
							let rest = '';
							if (lower.startsWith('order by')) {
								key = 'order by';
								rest = after.slice('order by'.length);
							} else if (lower.startsWith('sort by')) {
								key = 'sort by';
								rest = after.slice('sort by'.length);
							} else {
								const m = after.match(/^([A-Za-z_][\w-]*)\b/);
								if (!m || !m[1]) return null;
								key = String(m[1]).toLowerCase();
								rest = after.slice(m[0].length);
								if (key === 'filter') key = 'where';
								if (key === 'parse-where') key = 'parse';
							}
							const headerHasArgs = /\S/.test(String(rest || ''));
							return { key, headerHasArgs, pipeIdx };
						} catch {
							return null;
						}
					};

					const __kustoParsePipeHeaderFromLine = (trimmedPipeLine) => {
						try {
							const t = String(trimmedPipeLine || '').trim();
							if (!t.startsWith('|')) return null;
							const after = t.slice(1).trim();
							if (!after) return null;
							const lower = after.toLowerCase();
							if (lower.startsWith('order by')) {
								return { key: 'order by', rest: after.slice('order by'.length) };
							}
							if (lower.startsWith('sort by')) {
								return { key: 'sort by', rest: after.slice('sort by'.length) };
							}
							const m = after.match(/^([A-Za-z_][\w-]*)\b/);
							if (!m || !m[1]) return null;
							let key = String(m[1]).toLowerCase();
							let rest = after.slice(m[0].length);
							if (key === 'filter') key = 'where';
							if (key === 'parse-where') key = 'parse';
							return { key, rest };
						} catch {
							return null;
						}
					};

					const __kustoPipeHeaderAllowsIndentedContinuation = (pipeHeader) => {
						try {
							if (!pipeHeader || !pipeHeader.key) return false;
							const key = String(pipeHeader.key).toLowerCase();
							const rest = String(pipeHeader.rest || '');
							const restTrim = rest.trim();

							// Always multiline (common patterns where the next line can be part of the same clause).
							if (key === 'where' || key === 'summarize' || key === 'join' || key === 'lookup') return true;

							// Multiline list forms: header-only, then items.
							if (key === 'extend' || key === 'project' || key === 'project-rename' || key === 'project-away' || key === 'project-keep' || key === 'project-reorder' || key === 'project-smart' || key === 'distinct') {
								return restTrim.length === 0;
							}

							// order/sort: allow a multiline form when no columns are provided on the header line.
							if (key === 'order by' || key === 'sort by') {
								return restTrim.length === 0;
							}

							// top: allow multiline when it ends with `by` and no columns follow.
							if (key === 'top') {
								// Examples:
								//  | top 5 by
								//      Col1 desc,
								const lower = (key + ' ' + restTrim).toLowerCase();
								return /\bby\s*$/.test(lower);
							}
							return false;
						} catch {
							return false;
						}
					};

					const __kustoGetStatementStartAtOffset = (text, offset) => {
						const raw = String(text || '');
						const end = Math.max(0, Math.min(raw.length, Number(offset) || 0));
						let last = -1;
						let depth = 0;
						let inLineComment = false;
						let inBlockComment = false;
						let inSingle = false;
						let inDouble = false;
						for (let i = 0; i < end; i++) {
							const ch = raw[i];
							const next = raw[i + 1];
							if (inLineComment) {
								// End line comment at EOL, then continue processing the newline as whitespace.
								if (ch !== '\n') {
									continue;
								}
								inLineComment = false;
							}
							if (inBlockComment) {
								if (ch === '*' && next === '/') { inBlockComment = false; i++; }
								continue;
							}
							if (inSingle) {
								if (ch === "'") {
									if (next === "'") { i++; continue; }
									inSingle = false;
								}
								continue;
							}
							if (inDouble) {
								if (ch === '\\') { i++; continue; }
								if (ch === '"') inDouble = false;
								continue;
							}
							if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
							if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
							if (ch === "'") { inSingle = true; continue; }
							if (ch === '"') { inDouble = true; continue; }
							if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
							if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
							if (ch === ';' && depth === 0) { last = i; continue; }
							// Blank-line statement separator: treat one-or-more blank lines as a boundary.
							// IMPORTANT: a single newline without a blank line is NOT a separator.
							if (ch === '\n' && depth === 0) {
								let j = i + 1;
								// Skip whitespace on the *next* line.
								while (j < end) {
									const c = raw[j];
									if (c === ' ' || c === '\t' || c === '\r') { j++; continue; }
									break;
								}
								if (j < end && raw[j] === '\n') {
									// Found a blank line (\n[ \t]*\n). Consider the statement boundary
									// as ending at this newline so the next statement starts at j+1.
									last = j;
								}
								continue;
							}
						}
						return last + 1;
					};

					const __kustoBuildLineStarts = (text) => {
						const starts = [0];
						for (let i = 0; i < text.length; i++) {
							const ch = text.charCodeAt(i);
							if (ch === 10 /* \n */) {
								starts.push(i + 1);
							}
						}
						return starts;
					};

					const __kustoOffsetToPosition = (lineStarts, offset) => {
						const off = __kustoClamp(offset, 0, Number.MAX_SAFE_INTEGER);
						let lo = 0;
						let hi = lineStarts.length - 1;
						while (lo <= hi) {
							const mid = (lo + hi) >> 1;
							const start = lineStarts[mid];
							const nextStart = (mid + 1 < lineStarts.length) ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
							if (off < start) {
								hi = mid - 1;
							} else if (off >= nextStart) {
								lo = mid + 1;
							} else {
								return { lineNumber: mid + 1, column: (off - start) + 1 };
							}
						}
						// Fallback
						const lastLine = Math.max(1, lineStarts.length);
						const start = lineStarts[lastLine - 1] || 0;
						return { lineNumber: lastLine, column: (off - start) + 1 };
					};

					const __kustoIsIdentStart = (ch) => {
						return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95; // A-Z a-z _
					};
					const __kustoIsIdentPart = (ch) => {
						return __kustoIsIdentStart(ch) || (ch >= 48 && ch <= 57) || ch === 45; // 0-9 -
					};

					const __kustoScanIdentifiers = (text) => {
						// Lightweight lexer that returns identifier tokens with offsets.
						const tokens = [];
						let i = 0;
						let depth = 0;
						while (i < text.length) {
							const ch = text.charCodeAt(i);
							// Newlines/whitespace
							if (ch === 10 || ch === 13 || ch === 9 || ch === 32) {
								i++;
								continue;
							}
							// Line comments
							if (ch === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
								while (i < text.length && text.charCodeAt(i) !== 10) i++;
								continue;
							}
							// Block comments
							if (ch === 47 /* / */ && text.charCodeAt(i + 1) === 42 /* * */) {
								i += 2;
								while (i < text.length) {
									if (text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47) {
										i += 2;
										break;
									}
									i++;
								}
								continue;
							}
							// Strings (single or double)
							if (ch === 39 /* ' */ || ch === 34 /* \" */) {
								const quote = ch;
								i++;
								while (i < text.length) {
									const c = text.charCodeAt(i);
									if (c === quote) {
										// Kusto single-quote escaping: ''
										if (quote === 39 && text.charCodeAt(i + 1) === 39) {
											i += 2;
											continue;
										}
										i++;
										break;
									}
									// Basic escape support for double quotes
									if (quote === 34 && c === 92 /* \\ */) {
										i += 2;
										continue;
									}
									i++;
								}
								continue;
							}
							// Track depth so we can skip nested pipelines in v1.
							if (ch === 40 /* ( */ || ch === 91 /* [ */ || ch === 123 /* { */) {
								depth++;
								i++;
								continue;
							}
							if (ch === 41 /* ) */ || ch === 93 /* ] */ || ch === 125 /* } */) {
								depth = Math.max(0, depth - 1);
								i++;
								continue;
							}
							// Identifiers
							if (__kustoIsIdentStart(ch)) {
								const start = i;
								i++;
								while (i < text.length && __kustoIsIdentPart(text.charCodeAt(i))) {
									i++;
								}
								const value = text.slice(start, i);
								tokens.push({ type: 'ident', value, offset: start, endOffset: i, depth });
								continue;
							}
							// Pipe
							if (ch === 124 /* | */) {
								tokens.push({ type: 'pipe', value: '|', offset: i, endOffset: i + 1, depth });
								i++;
								continue;
							}
							// Other
							i++;
						}
						return tokens;
					};

					const __kustoLevenshtein = (a, b) => {
						const s = String(a || '');
						const t = String(b || '');
						if (s === t) return 0;
						if (!s) return t.length;
						if (!t) return s.length;
						const n = s.length;
						const m = t.length;
						const prev = new Array(m + 1);
						const cur = new Array(m + 1);
						for (let j = 0; j <= m; j++) prev[j] = j;
						for (let i = 1; i <= n; i++) {
							cur[0] = i;
							const sc = s.charCodeAt(i - 1);
							for (let j = 1; j <= m; j++) {
								const cost = (sc === t.charCodeAt(j - 1)) ? 0 : 1;
								cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
							}
							for (let j = 0; j <= m; j++) prev[j] = cur[j];
						}
						return prev[m];
					};

					const __kustoBestMatches = (needle, candidates, maxCount) => {
						const n = String(needle || '');
						const nl = n.toLowerCase();
						const out = [];
						const seen = new Set();
						const max = Math.max(1, maxCount || 5);
						for (const c of (Array.isArray(candidates) ? candidates : [])) {
							const cand = String(c || '');
							if (!cand) continue;
							const cl = cand.toLowerCase();
							const dist = __kustoLevenshtein(nl, cl);
							const prefixBoost = cl.startsWith(nl) ? -2 : 0;
							const score = dist + prefixBoost;
							out.push({ cand, score });
						}
						out.sort((a, b) => a.score - b.score || a.cand.localeCompare(b.cand));
						const best = [];
						for (const it of out) {
							if (best.length >= max) break;
							const key = it.cand.toLowerCase();
							if (seen.has(key)) continue;
							seen.add(key);
							best.push(it.cand);
						}
						return best;
					};

					const __kustoGetSchemaForModel = (model) => {
						let boxId = null;
						try {
							boxId = model && model.uri ? (queryEditorBoxByModelUri[model.uri.toString()] || null) : null;
						} catch { boxId = null; }
						if (!boxId) {
							boxId = activeQueryEditorBoxId;
						}
						return { boxId, schema: boxId ? (schemaByBoxId[boxId] || null) : null };
					};

					const __kustoComputeDiagnostics = (text, schema) => {
						const markers = [];
						const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						if (!raw.trim()) {
							return markers;
						}
						const lineStarts = __kustoBuildLineStarts(raw);

						// Tabular parameters inside user-defined functions should behave like valid table variables
						// within the function body, e.g.
						//   let f = (T:(col:type)) { T | summarize ... };
						const __kustoTabularParamScopes = (() => {
							try {
								const scopes = [];
								const s = raw;
								const re = /(^|\n)\s*let\s+[A-Za-z_][\w-]*\s*=\s*\(/gi;
								for (const m of s.matchAll(re)) {
									const idx = (typeof m.index === 'number') ? m.index : -1;
									if (idx < 0) continue;
									const openParen = s.indexOf('(', idx);
									if (openParen < 0) continue;
									let parenDepth = 1;
									let closeParen = -1;
									for (let i = openParen + 1; i < s.length; i++) {
										const ch = s[i];
										if (ch === '(') parenDepth++;
										else if (ch === ')') {
											parenDepth--;
											if (parenDepth === 0) {
												closeParen = i;
												break;
											}
										}
									}
									if (closeParen < 0) continue;
									const paramText = s.slice(openParen + 1, closeParen);
									const names = new Set();
									try {
										for (const pm of paramText.matchAll(/([A-Za-z_][\w-]*)\s*:\s*\(/g)) {
											if (pm && pm[1]) names.add(String(pm[1]).toLowerCase());
										}
									} catch { /* ignore */ }
									if (!names.size) continue;
									let bodyStart = -1;
									for (let j = closeParen + 1; j < s.length; j++) {
										const ch = s[j];
										if (ch === '{') {
											bodyStart = j;
											break;
										}
										if (ch === ';') break;
									}
									if (bodyStart < 0) continue;
									let braceDepth = 1;
									let bodyEnd = -1;
									for (let k = bodyStart + 1; k < s.length; k++) {
										const ch = s[k];
										if (ch === '{') braceDepth++;
										else if (ch === '}') {
											braceDepth--;
											if (braceDepth === 0) {
												bodyEnd = k;
												break;
											}
										}
									}
									if (bodyEnd < 0) continue;
									scopes.push({ startOffset: bodyStart + 1, endOffset: bodyEnd - 1, names });
								}
								return scopes;
							} catch {
								return [];
							}
						})();

						const __kustoIsTabularParamInScope = (nameLower, offset) => {
							try {
								const n = String(nameLower || '').toLowerCase();
								const off = Number(offset) || 0;
								for (const sc of (__kustoTabularParamScopes || [])) {
									if (!sc || !sc.names) continue;
									if (off >= sc.startOffset && off <= sc.endOffset && sc.names.has(n)) return true;
								}
								return false;
							} catch {
								return false;
							}
						};

						const tables = (schema && Array.isArray(schema.tables)) ? schema.tables : [];
						const columnsByTable = __kustoGetColumnsByTable(schema);
						const columnTypesByTable = (schema && schema.columnTypesByTable && typeof schema.columnTypesByTable === 'object') ? schema.columnTypesByTable : null;

						// Any declared `let` identifier is considered a valid tabular reference for diagnostics purposes,
						// even if we can't resolve it back to a schema table.
						const __kustoDeclaredLetNames = new Set();
						const __kustoDeclaredLetNamesOriginal = [];
						try {
							for (const m of raw.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
								if (m && m[2]) {
									const original = String(m[2]);
									const lower = original.toLowerCase();
									if (!__kustoDeclaredLetNames.has(lower)) {
										__kustoDeclaredLetNames.add(lower);
										__kustoDeclaredLetNamesOriginal.push(original);
									}
								}
							}
						} catch { /* ignore */ }

						// Candidates for unknown-table suggestions: schema tables + declared `let` variables.
						const __kustoTabularNameCandidates = (() => {
							try {
								const byLower = new Map();
								for (const t of (tables || [])) {
									const s = String(t);
									byLower.set(s.toLowerCase(), s);
								}
								for (const v of (__kustoDeclaredLetNamesOriginal || [])) {
									const s = String(v);
									byLower.set(s.toLowerCase(), s);
								}
								return Array.from(byLower.values());
							} catch {
								return (tables || []).slice();
							}
						})();

						const __kustoResolveTabularLetToTable = (() => {
							const tablesByLower = {};
							try {
								for (const t of tables) {
									tablesByLower[String(t).toLowerCase()] = String(t);
								}
							} catch { /* ignore */ }
							const letSources = {};
							const extractSourceLower = (rhsText) => {
								const rhs = String(rhsText || '').trim();
								if (!rhs) return null;
								try {
									const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
									if (m && m[1]) return String(m[1]).toLowerCase();
								} catch { /* ignore */ }
								try {
									const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
									if (m && m[1]) return String(m[1]).toLowerCase();
								} catch { /* ignore */ }
								try {
									const m = rhs.replace(/^\(\s*/g, '').trim().match(/^([A-Za-z_][\w-]*)\b/);
									return (m && m[1]) ? String(m[1]).toLowerCase() : null;
								} catch { return null; }
							};
							try {
								const lines = raw.split('\n');
								for (let i = 0; i < lines.length; i++) {
									const trimmed = lines[i].trim();
									if (!/^let\s+/i.test(trimmed)) continue;
									let stmt = lines[i];
									while (i + 1 < lines.length && stmt.indexOf(';') === -1) {
										i++;
										stmt += '\n' + lines[i];
									}
									const m = stmt.match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)(;|$)/i);
									if (!m || !m[1] || !m[2]) continue;
									const letNameLower = String(m[1]).toLowerCase();
									let rhs = String(m[2]).trim();
									const srcLower = extractSourceLower(rhs);
									if (!srcLower) continue;
									letSources[letNameLower] = srcLower;
								}
							} catch { /* ignore */ }
							return (nameLower) => {
								let cur = String(nameLower || '').toLowerCase();
								for (let depth = 0; depth < 8; depth++) {
									if (tablesByLower[cur]) return tablesByLower[cur];
									if (!letSources[cur]) return null;
									cur = letSources[cur];
								}
								return null;
							};
						})();

												const __kustoParseFullyQualifiedTableExpr = (text) => {
													try {
														const s = String(text || '');
														const m = s.match(/\bcluster\s*\(\s*'([^']+)'\s*\)\s*\.\s*database\s*\(\s*'([^']+)'\s*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
														if (m && m[1] && m[2] && m[3]) {
															return { cluster: String(m[1]), database: String(m[2]), table: String(m[3]) };
														}
														return null;
													} catch {
														return null;
													}
												};

												// Unknown table checks: (1) statement-first identifier; (2) join/from identifier.
						const reportUnknownName = (code, name, startOffset, endOffset, candidates, what) => {
							const start = __kustoOffsetToPosition(lineStarts, startOffset);
							const end = __kustoOffsetToPosition(lineStarts, Math.max(startOffset + 1, endOffset));
													const prefixLower = String(name || '').toLowerCase();
													const filtered = prefixLower
														? (candidates || []).filter((c) => String(c || '').toLowerCase().startsWith(prefixLower))
														: (candidates || []);
													const best = __kustoBestMatches(name, filtered, 5);
							const didYouMean = best.length ? (' Did you mean: ' + best.map(s => '`' + s + '`').join(', ') + '?') : '';
							markers.push({
								severity: monaco.MarkerSeverity.Error,
								startLineNumber: start.lineNumber,
								startColumn: start.column,
								endLineNumber: end.lineNumber,
								endColumn: end.column,
								message: 'Unknown ' + what + ' `' + name + '`.' + didYouMean,
								code
							});
						};

						const statements = __kustoSplitTopLevelStatements(raw);
						const stmts = (statements && statements.length) ? statements : [{ startOffset: 0, text: raw }];
						for (const st of stmts) {
							const stmtText = String(st && st.text ? st.text : '');
							const baseOffset = Number(st && st.startOffset) || 0;

							// Management/control commands (dot-prefixed) are not validated by our lightweight query diagnostics.
							// Skip the whole statement to avoid false squiggles.
							try {
								const lines = stmtText.split('\n');
								let first = '';
								for (const ln of lines) {
									const t = String(ln || '').trim();
									if (!t || t === ';') continue;
									if (t.startsWith('//')) continue;
									first = t;
									break;
								}
								if (first.startsWith('.')) {
									continue;
								}
							} catch { /* ignore */ }

							// First identifier on a statement line (best-effort).
							try {
														const lines = stmtText.split('\n');
														let runningOffset = baseOffset;
														let statementHasLeadingId = false;
														for (let li = 0; li < lines.length; li++) {
															const line = lines[li];
									const trimmed = line.trim();
									if (!trimmed) {
										statementHasLeadingId = false;
										runningOffset += line.length + 1;
										continue;
									}
									if (trimmed.startsWith('|') || trimmed.startsWith('.') || trimmed.startsWith('//')) {
										runningOffset += line.length + 1;
										continue;
									}
									if (statementHasLeadingId) {
										runningOffset += line.length + 1;
										continue;
									}
														// Fully-qualified tabular expression at statement start.
														try {
															const fq = __kustoParseFullyQualifiedTableExpr(line);
															if (fq) {
																statementHasLeadingId = true;
																runningOffset += line.length + 1;
																continue;
															}
														} catch { /* ignore */ }
									const m = line.match(/^\s*([A-Za-z_][\w-]*)\b/);
									if (m && m[1]) {
										const name = m[1];
										const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
														const nameLower = name.toLowerCase();
														const tryValidateLetRhsTable = () => {
															try {
																// Supports:
																//  - let X = Table
																//  - let X =\n  Table
																const letLine = String(line || '');
																if (!/^\s*let\s+/i.test(letLine)) return { handled: false };
																const eqIdx = letLine.indexOf('=');
																let rhsText = '';
																if (eqIdx >= 0) {
																	rhsText = letLine.slice(eqIdx + 1);
																}
																let rhs = String(rhsText || '').trim();
																	if (!rhs) {
																		// Multiline `let X =` – peek next non-empty, non-pipe/comment line.
																		for (let k = li + 1; k < lines.length; k++) {
																			const cand = String(lines[k] || '');
																			const tr = cand.trim();
																			if (!tr) continue;
																			if (tr === ';') continue;
																			if (tr.startsWith('|') || tr.startsWith('.') || tr.startsWith('//')) continue;
																			rhs = tr;
																			break;
																		}
																}

																// Fully-qualified RHS
																try {
																	const fq2 = __kustoParseFullyQualifiedTableExpr(rhs);
																	if (fq2) {
																		return { handled: true, ok: true };
																	}
																} catch { /* ignore */ }
																const mSrc = rhs.match(/^([A-Za-z_][\w-]*)\b/);
																if (!mSrc || !mSrc[1]) return { handled: true, ok: true };
																const srcName = String(mSrc[1]);
																// Ignore scalar function calls: datetime(...), now(), etc.
																try {
																	const after = rhs.slice(mSrc[0].length);
																	if (/^\s*\(/.test(after)) return { handled: true, ok: true };
																} catch { /* ignore */ }
																// Let-declared names are always valid identifiers.
																if (__kustoDeclaredLetNames.has(srcName.toLowerCase())) return { handled: true, ok: true };
																if (__kustoResolveTabularLetToTable(srcName.toLowerCase())) return { handled: true, ok: true };
																if (tables.length && !tables.some(t => String(t).toLowerCase() === srcName.toLowerCase())) {
																	const localStart = line.toLowerCase().indexOf(srcName.toLowerCase());
																	if (localStart >= 0) {
																		reportUnknownName('KW_UNKNOWN_TABLE', srcName, runningOffset + localStart, runningOffset + localStart + srcName.length, __kustoTabularNameCandidates, 'table');
																	}
																}
																return { handled: true, ok: true };
															} catch {
																return { handled: false };
															}
														};

														if (!ignore.has(nameLower)) {
											if (__kustoDeclaredLetNames.has(String(name).toLowerCase())) {
												statementHasLeadingId = true;
												runningOffset += line.length + 1;
												continue;
											}
											try {
												const localStart = line.indexOf(name);
												if (localStart >= 0 && __kustoIsTabularParamInScope(nameLower, runningOffset + localStart)) {
													statementHasLeadingId = true;
													runningOffset += line.length + 1;
													continue;
												}
											} catch { /* ignore */ }
											const resolvedLet = __kustoResolveTabularLetToTable(name.toLowerCase());
											if (!resolvedLet) {
												if (tables.length && !tables.some(t => String(t).toLowerCase() === name.toLowerCase())) {
													const localStart = line.indexOf(name);
													if (localStart >= 0) {
														reportUnknownName('KW_UNKNOWN_TABLE', name, runningOffset + localStart, runningOffset + localStart + name.length, __kustoTabularNameCandidates, 'table');
													}
												}
											}
										}
																statementHasLeadingId = true;
																// If this was a `let` line, we still allow the RHS source line to be picked up when the RHS is on the next line.
																if (nameLower === 'let') {
																	const handled = tryValidateLetRhsTable();
																	if (handled && handled.handled) {
																		statementHasLeadingId = true;
																	} else {
																		// Don't block scanning: let RHS might be on the next line.
																		statementHasLeadingId = false;
																	}
																}
									}
									runningOffset += line.length + 1;
								}
							} catch { /* ignore */ }

							// Basic syntax-ish check: once a statement has started piping, any subsequent non-empty line
							// should either start with '|' or be a continuation of a multiline operator.
							try {
								const lines = stmtText.split('\n');
								let runningOffset = baseOffset;
								let sawPipe = false;
								let allowIndentedContinuation = false;
								let lastPipeHeader = null;
									let expectPipeAfterBareId = false;
								for (const line of lines) {
									const trimmed = line.trim();
										if (!trimmed || trimmed === ';') {
										sawPipe = false;
										allowIndentedContinuation = false;
										lastPipeHeader = null;
										expectPipeAfterBareId = false;
										runningOffset += line.length + 1;
										continue;
									}
									if (trimmed.startsWith('//')) {
										runningOffset += line.length + 1;
										continue;
									}
									// Allow closing a let/function body block after a piped query, e.g.
									// let Base = () { T | where ... };
									if (/^\}\s*;?\s*$/.test(trimmed)) {
										sawPipe = false;
										allowIndentedContinuation = false;
										lastPipeHeader = null;
										expectPipeAfterBareId = false;
										runningOffset += line.length + 1;
										continue;
									}
										if (trimmed.startsWith('|')) {
										sawPipe = true;
										lastPipeHeader = __kustoParsePipeHeaderFromLine(trimmed);
										allowIndentedContinuation = __kustoPipeHeaderAllowsIndentedContinuation(lastPipeHeader);
										expectPipeAfterBareId = false;
										__kustoDiagLog('pipe line', {
											stmtStartOffset: baseOffset,
											lineRaw: line,
											pipeHeader: lastPipeHeader,
											allowContinuation: allowIndentedContinuation
										});
										runningOffset += line.length + 1;
										continue;
									}
									if (!sawPipe) {
										const isBareIdentLine = /^([A-Za-z_][\w-]*)\s*(?:\/\/.*)?$/.test(trimmed);
										if (expectPipeAfterBareId) {
											const localStart = line.search(/\S/);
											const startOffset = runningOffset + Math.max(0, localStart);
											const firstToken = (localStart >= 0 ? line.slice(localStart).match(/^([A-Za-z_][\w-]*)/) : null);
											const tokLen = firstToken && firstToken[1] ? firstToken[1].length : 1;
											const start = __kustoOffsetToPosition(lineStarts, startOffset);
											const end = __kustoOffsetToPosition(lineStarts, Math.max(startOffset + 1, startOffset + tokLen));
											markers.push({
												severity: monaco.MarkerSeverity.Error,
												startLineNumber: start.lineNumber,
												startColumn: start.column,
												endLineNumber: end.lineNumber,
												endColumn: end.column,
												message: 'Unexpected text after a query source. Did you forget to prefix this line with `|`?',
												code: 'KW_EXPECTED_PIPE'
											});
											expectPipeAfterBareId = false;
											runningOffset += line.length + 1;
											continue;
										}
										if (isBareIdentLine) {
											expectPipeAfterBareId = true;
											runningOffset += line.length + 1;
											continue;
										}
									}
									if (sawPipe) {
										const tLower = String(trimmed || '').toLowerCase();
										// Allow indented continuation lines for multiline operators.
										// Also allow common clause keywords (by/on) when multiline summarize/join is active.
										// Note: we do NOT require indentation; in KQL, newlines are whitespace.
										if (allowIndentedContinuation || tLower === 'by' || tLower === 'on') {
											runningOffset += line.length + 1;
											continue;
										}
										const localStart = line.search(/\S/);
										const startOffset = runningOffset + Math.max(0, localStart);
										const firstToken = (localStart >= 0 ? line.slice(localStart).match(/^([A-Za-z_][\w-]*)/) : null);
										const tokLen = firstToken && firstToken[1] ? firstToken[1].length : 1;
										const start = __kustoOffsetToPosition(lineStarts, startOffset);
										const end = __kustoOffsetToPosition(lineStarts, Math.max(startOffset + 1, startOffset + tokLen));
										markers.push({
											severity: monaco.MarkerSeverity.Error,
											startLineNumber: start.lineNumber,
											startColumn: start.column,
											endLineNumber: end.lineNumber,
											endColumn: end.column,
											message: 'Unexpected text after a pipe operator. Did you forget to prefix this line with `|`?',
											code: 'KW_EXPECTED_PIPE'
										});
									}
									runningOffset += line.length + 1;
								}
							} catch { /* ignore */ }

							try {
								const extractJoinOrLookupRightTable = (seg) => {
									try {
										const clause = String(seg || '');
										const paren = clause.match(/\(([^)]*)\)/);
										if (paren && paren[1]) {
											const mName = String(paren[1]).trim().match(/^([A-Za-z_][\w-]*)\b/);
											if (mName && mName[1]) return mName[1];
										}
										const openParen = clause.match(/\(\s*([A-Za-z_][\w-]*)\b/);
										if (openParen && openParen[1]) return openParen[1];
										const afterOp = clause.replace(/^(join|lookup)\b/i, '').trim();
										const withoutOpts = afterOp
											.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
											.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/ig, ' ')
											.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
											.trim();
										const mName = withoutOpts.match(/^([A-Za-z_][\w-]*)\b/);
										return mName && mName[1] ? mName[1] : null;
									} catch {
										return null;
									}
								};

								for (const m of stmtText.matchAll(/\b(join|lookup|from)\b/gi)) {
									const kw = String(m[1] || '').toLowerCase();
									const idx = (typeof m.index === 'number') ? m.index : -1;
									if (idx < 0) continue;
									let end = stmtText.indexOf('\n', idx);
									if (end < 0) end = stmtText.length;
									const seg = stmtText.slice(idx, end);
									let name = null;
									if (kw === 'from') {
										const mm = seg.match(/^from\s+([A-Za-z_][\w-]*)\b/i);
										name = mm && mm[1] ? mm[1] : null;
									} else {
										name = extractJoinOrLookupRightTable(seg);
									}
									if (!name) continue;
															// If the segment contains a fully-qualified table expression, skip unknown-table checks.
															try {
																if (__kustoParseFullyQualifiedTableExpr(seg)) {
																	continue;
																}
															} catch { /* ignore */ }
										if (__kustoDeclaredLetNames.has(String(name).toLowerCase())) continue;
										try {
											const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
											const startOffset = baseOffset + idx + Math.max(0, localStart);
											if (__kustoIsTabularParamInScope(String(name).toLowerCase(), startOffset)) {
												continue;
											}
										} catch { /* ignore */ }
									if (__kustoResolveTabularLetToTable(String(name).toLowerCase())) continue;
									if (tables.length && !tables.some(t => String(t).toLowerCase() === String(name).toLowerCase())) {
										const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
										const startOffset = baseOffset + idx + Math.max(0, localStart);
										reportUnknownName('KW_UNKNOWN_TABLE', name, startOffset, startOffset + String(name).length, __kustoTabularNameCandidates, 'table');
									}
								}
							} catch { /* ignore */ }
						}

						// Column checks: best-effort pipeline simulation at top-level (depth 0).
						if (tables.length && columnsByTable) {
							const isDynamicType = (t) => {
								const v = String(t ?? '').trim().toLowerCase();
								return v === 'dynamic' || v.includes('dynamic') || v === 'system.object' || v.includes('system.object') || v === 'object';
							};
							const getDynamicColumnsForTable = (table) => {
								const set = new Set();
								if (!table || !columnTypesByTable) return set;
								const types = columnTypesByTable[table];
								if (!types || typeof types !== 'object') return set;
								for (const [col, typ] of Object.entries(types)) {
									if (isDynamicType(typ)) set.add(String(col));
								}
								return set;
							};
							const getDotChainRoot = (s, identStart) => {
								let currentIdentStart = identStart;
								if (currentIdentStart <= 0 || s[currentIdentStart - 1] !== '.') return null;
								let root = null;
								while (currentIdentStart > 0 && s[currentIdentStart - 1] === '.') {
									let p = currentIdentStart - 2;
									while (p >= 0 && /\s/.test(s[p])) p--;
									const end = p + 1;
									while (p >= 0 && /[\w-]/.test(s[p])) p--;
									const start = p + 1;
									const seg = s.slice(start, end);
									if (!seg || !/^[A-Za-z_]/.test(seg)) break;
									root = seg;
									currentIdentStart = start;
								}
								return root;
							};
							const letNames = new Set();
							try {
								for (const m of raw.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
									if (m && m[2]) letNames.add(String(m[2]).toLowerCase());
								}
							} catch { /* ignore */ }

												const kw = new Set([
													'let','set','declare','print','range','datatable','externaldata',
													'where','project','extend','summarize','order','sort','by','take','top','distinct','join','from','on','kind','as',
													'and','or','not','in','has','contains','startswith','endswith','between','matches','true','false','null','case','then','else'
												]);
							const fnNames = new Set(Object.keys(KUSTO_FUNCTION_DOCS || {}).map(s => String(s).toLowerCase()));

							for (const st of stmts) {
								const stmtRaw = String(st && st.text ? st.text : '');
								const baseOffset = Number(st && st.startOffset) || 0;
								if (!stmtRaw.trim()) continue;

								// Statement-local string ranges (so semicolons don't confuse offsets).
								// IMPORTANT: run this over comment-masked text so apostrophes inside comments can't
								// accidentally open/close string literals and corrupt downstream identifier validation.
								const stringRanges = [];
								try {
									const stmtLex = __kustoMaskCommentsPreserveLayout(stmtRaw);
									let quote = null;
									let start = -1;
									for (let i = 0; i < stmtLex.length; i++) {
										const ch = stmtLex[i];
										if (quote) {
											if (ch === '\\') { i++; continue; }
											if (ch === quote) {
												stringRanges.push([start, i + 1]);
												quote = null;
												start = -1;
												continue;
											}
											continue;
										}
										if (ch === '"' || ch === "'") {
											quote = ch;
											start = i;
										}
									}
								} catch { /* ignore */ }
								let stringRangeIdx = 0;
								const isInStringLiteral = (localOffset) => {
									while (stringRangeIdx < stringRanges.length && stringRanges[stringRangeIdx][1] <= localOffset) {
										stringRangeIdx++;
									}
									const r = stringRanges[stringRangeIdx];
									return !!r && r[0] <= localOffset && localOffset < r[1];
								};

																	const tokens = __kustoScanIdentifiers(stmtRaw);

								// Infer active table from the statement (supports `let X = Table`).
								let activeTable = null;
								try {
									const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
									const lines = stmtRaw.split('\n');
									const mLet = stmtRaw.match(/^\s*let\s+[A-Za-z_][\w-]*\s*=([\s\S]*)$/i);
									let letSource = null;
									if (mLet && mLet[1]) {
										let rhs = String(mLet[1]).trim();
										rhs = rhs.replace(/^\(\s*/g, '').trim();
										const src = rhs.match(/^([A-Za-z_][\w-]*)\b/);
										if (src && src[1]) letSource = src[1];
									}
									if (letSource) {
										const found = tables.find(t => String(t).toLowerCase() === String(letSource).toLowerCase());
										if (found && columnsByTable[found]) {
											activeTable = found;
										}
										if (!activeTable) {
											const resolvedLet = __kustoResolveTabularLetToTable(String(letSource).toLowerCase());
											if (resolvedLet && columnsByTable[resolvedLet]) {
												activeTable = resolvedLet;
											}
										}
									}
									if (!activeTable) {
										for (const line of lines) {
											const trimmed = line.trim();
											if (!trimmed) continue;
											if (trimmed.startsWith('|') || trimmed.startsWith('.') || trimmed.startsWith('//')) continue;
											const m = line.match(/^\s*([A-Za-z_][\w-]*)\b/);
											if (!m || !m[1]) continue;
											const name = m[1];
											if (ignore.has(name.toLowerCase())) continue;
											const found = tables.find(t => String(t).toLowerCase() === String(name).toLowerCase());
											if (found && columnsByTable[found]) { activeTable = found; break; }
											const resolvedLet = __kustoResolveTabularLetToTable(String(name).toLowerCase());
											if (resolvedLet && columnsByTable[resolvedLet]) { activeTable = resolvedLet; break; }
										}
									}
								} catch { activeTable = null; }

								let colSet = null;
								let dynamicRootCols = new Set();
								if (activeTable) {
									colSet = new Set((columnsByTable[activeTable] || []).map(c => String(c)));
									dynamicRootCols = getDynamicColumnsForTable(activeTable);
								}

								const reportUnknownColumn = (name, localStartOffset, localEndOffset, candidates) => {
									reportUnknownName('KW_UNKNOWN_COLUMN', name, baseOffset + localStartOffset, baseOffset + localEndOffset, candidates, 'column');
								};

								const currentColumns = () => {
									if (!colSet) return [];
									return Array.from(colSet);
								};

								const isFunctionCall = (idx) => {
									try {
										const t = tokens[idx];
										if (!t || t.type !== 'ident') return false;
										const after = stmtRaw.slice(t.endOffset, Math.min(stmtRaw.length, t.endOffset + 6));
										return /^\s*\(/.test(after);
									} catch {
										return false;
									}
								};

																	let pipelineDepth = Number.POSITIVE_INFINITY;
																	for (const tok of tokens) {
																		if (tok && tok.type === 'pipe') pipelineDepth = Math.min(pipelineDepth, tok.depth);
																	}
																	if (!Number.isFinite(pipelineDepth)) {
																		continue;
																	}

																	for (let i = 0; i < tokens.length; i++) {
																		const t = tokens[i];
																		if (!t || t.depth !== pipelineDepth) continue;
																		if (t.type !== 'pipe') continue;

																		let opTok = null;
																		for (let j = i + 1; j < tokens.length; j++) {
																			const tt = tokens[j];
																			if (!tt || tt.depth !== pipelineDepth) continue;
										if (tt.type === 'ident') { opTok = tt; break; }
										if (tt.type === 'pipe') break;
									}
									if (!opTok) continue;
									const op = String(opTok.value || '').toLowerCase();
									if (!colSet) continue;

																		let clauseStart = opTok.endOffset;
																		let clauseEnd = stmtRaw.length;
																		for (let j = i + 1; j < tokens.length; j++) {
																			const tt = tokens[j];
																			if (!tt || tt.depth !== pipelineDepth) continue;
										if (tt.type === 'pipe' && tt.offset > opTok.offset) { clauseEnd = tt.offset; break; }
									}

									const clauseText = stmtRaw.slice(clauseStart, clauseEnd);
								// Operators that change column set (best-effort)
								const inputColSet = colSet ? new Set(colSet) : null;
								let nextColSet = null;
								if (op === 'extend') {
									// Add assigned columns: Name =
									for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
										try { colSet.add(m[1]); } catch { /* ignore */ }
									}
								}
								if (op === 'project') {
									// Project outputs only mentioned columns/aliases.
									const next = new Set();
									for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
										const name = m[1];
										if (!name) continue;
										const nl = name.toLowerCase();
										if (kw.has(nl)) continue;
										// If it's an alias assignment "X = Y", include X.
										const after = clauseText.slice(m.index + name.length);
										if (/^\s*=/.test(after)) {
											next.add(name);
											continue;
										}
										// Otherwise include it only if it existed previously.
										if (inputColSet && inputColSet.has(name)) {
											next.add(name);
										}
									}
									nextColSet = next;
								}
								if (op === 'summarize') {
									// Output = group-by keys + assigned aggregates (X = count())
									const next = new Set();
									// by keys (multiline-friendly): locate the last `by` token within this clause.
									try {
										let byTok = null;
																				for (let j = 0; j < tokens.length; j++) {
																					const tt = tokens[j];
																					if (!tt || tt.depth !== pipelineDepth) continue;
											if (tt.type !== 'ident') continue;
											if (tt.offset < clauseStart || tt.offset >= clauseEnd) continue;
											if (String(tt.value || '').toLowerCase() === 'by') {
												byTok = tt;
											}
										}
										if (byTok) {
											const byText = stmtRaw.slice(byTok.endOffset, clauseEnd);
												// Only include group-by output columns (aliases and bare keys).
												const splitTopLevelCommaList = (s) => {
													try {
														const text = String(s || '');
														const parts = [];
														let start = 0;
														let paren = 0, bracket = 0, brace = 0;
														let quote = null;
														for (let i = 0; i < text.length; i++) {
															const ch = text[i];
															if (quote) {
																if (ch === '\\') { i++; continue; }
																if (ch === quote) quote = null;
																continue;
															}
															if (ch === '"' || ch === "'") { quote = ch; continue; }
															if (ch === '(') paren++;
															else if (ch === ')' && paren > 0) paren--;
															else if (ch === '[') bracket++;
															else if (ch === ']' && bracket > 0) bracket--;
															else if (ch === '{') brace++;
															else if (ch === '}' && brace > 0) brace--;
															else if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
																parts.push(text.slice(start, i).trim());
																start = i + 1;
															}
														}
														parts.push(text.slice(start).trim());
														return parts.filter(Boolean);
													} catch { return []; }
												};
												for (const item of splitTopLevelCommaList(byText)) {
													const mAssign = String(item || '').match(/^([A-Za-z_][\w-]*)\s*=/);
													if (mAssign && mAssign[1]) { next.add(String(mAssign[1])); continue; }
													const mBare = String(item || '').match(/^([A-Za-z_][\w-]*)\s*$/);
													if (mBare && mBare[1]) { const name = String(mBare[1]); if (!inputColSet || inputColSet.has(name)) next.add(name); continue; }
													const mBin = String(item || '').match(/^bin\s*\(\s*([A-Za-z_][\w-]*)\b/i);
													if (mBin && mBin[1]) { const name = String(mBin[1]); if (!inputColSet || inputColSet.has(name)) next.add(name); continue; }
												}
										}
									} catch { /* ignore */ }
									// assigned aggregates
									for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
										try { next.add(m[1]); } catch { /* ignore */ }
									}
									nextColSet = next;
								}

								// Validate identifiers in certain clauses.
								const shouldValidateColumns = (op === 'where' || op === 'project' || op === 'extend' || op === 'summarize' || op === 'distinct' || op === 'take' || op === 'top' || op === 'order' || op === 'sort');
								if (!shouldValidateColumns) {
									continue;
								}
								const validateSet = (op === 'project' || op === 'summarize') ? (inputColSet || colSet) : colSet;
								// Scan identifiers in clauseText.
								for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
									const name = m[1];
									if (!name) continue;
									const nl = name.toLowerCase();
									if (kw.has(nl)) continue;
									if (fnNames.has(nl)) continue;
										// Only skip assignment LHS for operators that actually assign/rename columns.
										// In `where`, `Name = 'x'` is a comparison and must still validate `Name`.
										if (op === 'extend' || op === 'project' || op === 'summarize') {
											try {
												const afterLocal = clauseText.slice((typeof m.index === 'number' ? m.index : 0) + name.length);
												if (/^\s*=/.test(afterLocal)) continue;
											} catch { /* ignore */ }
										}
											// Skip if it's inside a string literal (statement-local offsets).
											const localOffset = clauseStart + (typeof m.index === 'number' ? m.index : 0);
											if (isInStringLiteral(localOffset)) {
										continue;
									}
									if (letNames.has(nl)) {
										continue;
									}
									try {
												const after = stmtRaw.slice(localOffset + name.length, Math.min(stmtRaw.length, localOffset + name.length + 6));
										if (/^\s*\(/.test(after)) {
											continue;
										}
									} catch { /* ignore */ }
									// Allow `dynamicColumn.any.property.chain` when the root is a known dynamic column.
									try {
										const localIndex = (typeof m.index === 'number') ? m.index : 0;
										const root = getDotChainRoot(clauseText, localIndex);
										if (root && validateSet && validateSet.has(root) && dynamicRootCols.has(root)) {
											continue;
										}
									} catch { /* ignore */ }
											if (validateSet && !validateSet.has(name)) {
												reportUnknownColumn(name, localOffset, localOffset + name.length, currentColumns());
									}
								}

								if (nextColSet) {
									colSet = nextColSet;
								}
							}
						}
					}
					return markers;
				};

				window.__kustoScheduleKustoDiagnostics = function (boxId, delayMs) {
						try {
							const id = String(boxId || '');
							if (!id) return;
							window.__kustoDiagnosticsTimersByBoxId = window.__kustoDiagnosticsTimersByBoxId || {};
							const timers = window.__kustoDiagnosticsTimersByBoxId;
							if (timers[id]) {
								clearTimeout(timers[id]);
								timers[id] = null;
							}
							const ms = (typeof delayMs === 'number') ? delayMs : 250;
							timers[id] = setTimeout(() => {
								(async () => {
									try {
										if (!queryEditors || !queryEditors[id]) return;
										const editor = queryEditors[id];
										const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
										if (!model) return;

										// IMPORTANT: Updating markers can close Monaco's quick-fix/lightbulb menu.
										// If it's open, defer diagnostics updates so the user can interact with it.
										try {
											const dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
											const menu = dom && dom.querySelector ? dom.querySelector('.context-view .monaco-menu-container') : null;
											if (menu) {
												const r = menu.getBoundingClientRect();
												const visible = (r && (r.width || 0) > 2 && (r.height || 0) > 2);
												if (visible) {
													// Reschedule shortly and bail.
													try { window.__kustoScheduleKustoDiagnostics(id, 350); } catch { /* ignore */ }
													return;
												}
											}
										} catch { /* ignore */ }

										const schema = schemaByBoxId ? (schemaByBoxId[id] || null) : null;
										const text = model.getValue();

										// Prefer extension-host language service when available.
										try {
											if (typeof window.__kustoRequestKqlDiagnostics === 'function') {
												let connectionId = '';
												let database = '';
												try {
													const c = document.getElementById(id + '_connection');
													const d = document.getElementById(id + '_database');
													connectionId = c ? String(c.value || '') : '';
													database = d ? String(d.value || '') : '';
												} catch { /* ignore */ }

											const remote = await window.__kustoRequestKqlDiagnostics({ boxId: id, text, connectionId, database });
											const diags = remote && remote.diagnostics;
											if (Array.isArray(diags)) {
												const markers = diags.map(d => {
													const sev = d && typeof d.severity === 'number' ? d.severity : 1;
													const s = d && d.range && d.range.start ? d.range.start : { line: 0, character: 0 };
													const e = d && d.range && d.range.end ? d.range.end : { line: s.line, character: s.character + 1 };
													return {
														severity: (sev === 2) ? monaco.MarkerSeverity.Warning : (sev === 3) ? monaco.MarkerSeverity.Info : (sev === 4) ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Error,
														startLineNumber: (s.line || 0) + 1,
														startColumn: (s.character || 0) + 1,
														endLineNumber: (e.line || 0) + 1,
														endColumn: (e.character || 0) + 1,
														message: String((d && d.message) || ''),
														code: d && d.code ? String(d.code) : undefined
												};
											});
															markers = await __kustoFilterMarkersByAutocomplete(model, markers);
															monaco.editor.setModelMarkers(model, KUSTO_DIAGNOSTICS_OWNER, markers);
												return;
											}
										}
										} catch { /* ignore */ }

												let markers = __kustoComputeDiagnostics(text, schema);
												markers = await __kustoFilterMarkersByAutocomplete(model, markers);
										monaco.editor.setModelMarkers(model, KUSTO_DIAGNOSTICS_OWNER, markers);
									} catch { /* ignore */ }
								})();
							}, ms);
						} catch {
							// ignore
						}
					};

					// Hover provider for diagnostics (shown on red underline hover).
					monaco.languages.registerHoverProvider('kusto', {
						provideHover: function (model, position) {
							try {
								const markers = monaco.editor.getModelMarkers({ owner: KUSTO_DIAGNOSTICS_OWNER, resource: model.uri });
								if (!markers || !markers.length) return null;
								const line = position.lineNumber;
								const col = position.column;
								const hit = markers.filter(m =>
									m.startLineNumber <= line && m.endLineNumber >= line &&
									(m.startLineNumber < line || m.startColumn <= col) &&
									(m.endLineNumber > line || m.endColumn >= col)
								);
								if (!hit.length) return null;
								const m = hit[0];
								return {
									range: new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn),
									contents: [{ value: '**Kusto syntax issue**\n\n' + String(m.message || '') }]
								};
							} catch {
								return null;
							}
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
					if (wrapper.dataset) {
						wrapper.dataset.kustoAutoResized = 'true';
					}
				} catch { /* ignore */ }
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

function __kustoToSingleLineKusto(input) {
	try {
		const text = String(input ?? '');
		if (!text.trim()) return '';

		let out = '';
		let inSingle = false;
		let inDouble = false;
		let inLineComment = false;
		let inBlockComment = false;
		let lineCommentBuf = '';
		let lastWasSpace = false;
		const pushSpace = () => {
			if (!lastWasSpace && out && !out.endsWith(' ')) {
				out += ' ';
				lastWasSpace = true;
			}
		};

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			const next = i + 1 < text.length ? text[i + 1] : '';

			if (inLineComment) {
				if (ch === '\n' || ch === '\r') {
					const c = lineCommentBuf.replace(/^\/\//, '').trim();
					if (c) {
						pushSpace();
						out += `/* ${c} */`;
						lastWasSpace = false;
					}
					lineCommentBuf = '';
					inLineComment = false;
					pushSpace();
				} else {
					lineCommentBuf += ch;
				}
				continue;
			}

			if (!inSingle && !inDouble && !inBlockComment && ch === '/' && next === '/') {
				inLineComment = true;
				lineCommentBuf = '//';
				i++;
				continue;
			}
			if (!inSingle && !inDouble && !inBlockComment && ch === '/' && next === '*') {
				inBlockComment = true;
				out += '/*';
				lastWasSpace = false;
				i++;
				continue;
			}
			if (inBlockComment) {
				out += ch;
				lastWasSpace = false;
				if (ch === '*' && next === '/') {
					out += '/';
					lastWasSpace = false;
					inBlockComment = false;
					i++;
				}
				continue;
			}

			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') {
					inSingle = !inSingle;
				}
				out += ch;
				lastWasSpace = false;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') {
					inDouble = !inDouble;
				}
				out += ch;
				lastWasSpace = false;
				continue;
			}

			if (!inSingle && !inDouble && /\s/.test(ch)) {
				pushSpace();
				continue;
			}

			out += ch;
			lastWasSpace = false;
		}

		if (inLineComment) {
			const c = lineCommentBuf.replace(/^\/\//, '').trim();
			if (c) {
				pushSpace();
				out += `/* ${c} */`;
			}
		}

		return out.replace(/\s+/g, ' ').trim();
	} catch {
		return String(input ?? '').replace(/\s+/g, ' ').trim();
	}
}

function __kustoExplodePipesToLines(input) {
	try {
		const text = String(input ?? '');
		if (!text) return '';
		let out = '';
		let inSingle = false;
		let inDouble = false;
		let depth = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inSingle = !inSingle;
				out += ch;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inDouble = !inDouble;
				out += ch;
				continue;
			}
			if (!inSingle && !inDouble) {
				if (ch === '(' || ch === '[' || ch === '{') depth++;
				else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
				if (depth === 0 && ch === '|') {
					// If this pipe isn't already at the start of a line, put it on a new line.
					let k = out.length - 1;
					while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
					if (k >= 0 && out[k] !== '\n') {
						out += '\n';
					}
				}
			}
			out += ch;
		}
		return out;
	} catch {
		return String(input ?? '');
	}
}

function __kustoSplitTopLevel(text, delimiterChar) {
	const parts = [];
	let buf = '';
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = i + 1 < text.length ? text[i + 1] : '';
		if (!inDouble && ch === "'") {
			const prev = i > 0 ? text[i - 1] : '';
			if (prev !== '\\') inSingle = !inSingle;
			buf += ch;
			continue;
		}
		if (!inSingle && ch === '"') {
			const prev = i > 0 ? text[i - 1] : '';
			if (prev !== '\\') inDouble = !inDouble;
			buf += ch;
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth === 0 && ch === delimiterChar) {
				parts.push(buf);
				buf = '';
				continue;
			}
		}
		buf += ch;
	}
	parts.push(buf);
	return parts;
}

function __kustoFindTopLevelKeyword(text, keywordLower) {
	try {
		const kw = String(keywordLower || '').toLowerCase();
		if (!kw) return -1;
		let depth = 0;
		let inSingle = false;
		let inDouble = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inSingle = !inSingle;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inDouble = !inDouble;
				continue;
			}
			if (inSingle || inDouble) continue;
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth !== 0) continue;

			// Word boundary check for keyword.
			if (i + kw.length <= text.length && text.slice(i, i + kw.length).toLowerCase() === kw) {
				const before = i > 0 ? text[i - 1] : ' ';
				const after = i + kw.length < text.length ? text[i + kw.length] : ' ';
				if (!/[A-Za-z0-9_\-]/.test(before) && !/[A-Za-z0-9_\-]/.test(after)) {
					return i;
				}
			}
		}
		return -1;
	} catch {
		return -1;
	}
}

function __kustoPrettifyWhereClause(rawAfterWhere) {
	const raw = String(rawAfterWhere ?? '');
	let items = [];
	let cond = '';
	let lastNewlineIdx = -1;
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let pendingOp = null;
	let lastWasSpace = false;
	const pushCondChar = (ch) => {
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (!lastWasSpace) {
				cond += ' ';
				lastWasSpace = true;
			}
			return;
		}
		cond += ch;
		lastWasSpace = false;
	};
	const flushCond = () => {
		const t = cond.replace(/\s+/g, ' ').trim();
		if (t) items.push({ type: 'cond', op: pendingOp, text: t });
		cond = '';
		lastWasSpace = false;
		pendingOp = null;
	};

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const next = i + 1 < raw.length ? raw[i + 1] : '';
		if (!inSingle && !inDouble && ch === '/' && next === '/') {
			// Line comment. Keep full-line comments as their own item; keep inline comments attached to the current condition.
			let j = i + 2;
			while (j < raw.length && raw[j] !== '\n' && raw[j] !== '\r') j++;
			const commentText = ('//' + raw.slice(i + 2, j)).replace(/[\r\n]+/g, '').trimRight();

			const sinceNl = raw.slice(lastNewlineIdx + 1, i);
			const isFullLine = /^\s*$/.test(sinceNl);
			if (isFullLine) {
				items.push({ type: 'comment', text: commentText, inline: false });
			} else {
				// Inline comment should remain with the condition it trails.
				// Normalize spacing before the comment.
				cond = cond.replace(/\s+$/g, '');
				cond += ' ' + commentText;
				lastWasSpace = false;
			}
			i = j - 1;
			continue;
		}
		if (!inDouble && ch === "'") {
			const prev = i > 0 ? raw[i - 1] : '';
			if (prev !== '\\') inSingle = !inSingle;
			pushCondChar(ch);
			continue;
		}
		if (!inSingle && ch === '"') {
			const prev = i > 0 ? raw[i - 1] : '';
			if (prev !== '\\') inDouble = !inDouble;
			pushCondChar(ch);
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === '\n' || ch === '\r') {
				lastNewlineIdx = i;
			}
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth === 0) {
				// Detect top-level 'and' / 'or' keywords.
				const slice3 = i + 3 <= raw.length ? raw.slice(i, i + 3).toLowerCase() : '';
				const slice2 = i + 2 <= raw.length ? raw.slice(i, i + 2).toLowerCase() : '';
				const kw = (slice3 === 'and') ? 'and' : ((slice2 === 'or') ? 'or' : '');
				if (kw) {
					const before = i > 0 ? raw[i - 1] : ' ';
					const after = i + kw.length < raw.length ? raw[i + kw.length] : ' ';
					if (!/[A-Za-z0-9_\-]/.test(before) && !/[A-Za-z0-9_\-]/.test(after)) {
						flushCond();
						pendingOp = kw;
						i += (kw.length - 1);
						continue;
					}
				}
			}
		}
		pushCondChar(ch);
	}
	flushCond();
	return items;
}

function __kustoPrettifyKusto(input) {
	let raw = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	// If the query is currently single-line (or has multiple pipe clauses on one line), explode pipes
	// back into separate lines before applying the rule-based formatter.
	try {
		raw = __kustoExplodePipesToLines(raw);
	} catch { /* ignore */ }
	const lines = raw.split('\n').map((l) => String(l).replace(/[ \t]+$/g, ''));

	const out = [];
	let i = 0;
	while (i < lines.length) {
		const lineRaw = lines[i];
		const trimmed = lineRaw.trim();
		if (!trimmed) {
			// Collapse large runs of blank lines.
			if (out.length === 0 || out[out.length - 1] === '') {
				i++;
				continue;
			}
			out.push('');
			i++;
			continue;
		}

		const isPipe = trimmed.startsWith('|');
		const isSummarize = /^\|\s*summarize\b/i.test(trimmed);
		const isWhere = /^\|\s*where\b/i.test(trimmed);
		const isCreateFn = /^\s*\.(create|create-or-alter)\s+function\b/i.test(trimmed);

		if (isSummarize) {
			const block = [];
			let j = i;
			for (; j < lines.length; j++) {
				const t = String(lines[j] || '').trim();
				if (j !== i && t.startsWith('|')) break;
				block.push(lines[j]);
			}
			const joined = block.join(' ').replace(/\s+/g, ' ').trim();
			const after = joined.replace(/^\|\s*summarize\b/i, '').trim();
			const byIdx = __kustoFindTopLevelKeyword(after, 'by');
			const aggText = byIdx >= 0 ? after.slice(0, byIdx).trim() : after;
			const byText = byIdx >= 0 ? after.slice(byIdx + 2).trim() : '';

			out.push('| summarize');
			const aggItems = __kustoSplitTopLevel(aggText, ',')
				.map((s) => String(s || '').trim())
				.filter(Boolean)
				.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim());
			for (const a of aggItems) {
				out.push('    ' + a);
			}

			const byItems = __kustoSplitTopLevel(byText, ',')
				.map((s) => String(s || '').trim())
				.filter(Boolean)
				.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim());
			if (byItems.length) {
				out.push('    by');
				for (let k = 0; k < byItems.length; k++) {
					const comma = (k < byItems.length - 1) ? ',' : '';
					out.push('    ' + byItems[k] + comma);
				}
			}
			i = j;
			continue;
		}

		if (isWhere) {
			const block = [];
			let j = i;
			for (; j < lines.length; j++) {
				const t = String(lines[j] || '').trim();
				if (j !== i && t.startsWith('|')) break;
				block.push(lines[j]);
			}
			const first = String(block[0] || '').trim();
			const after = first.replace(/^\|\s*where\b/i, '').trim();
			const rest = block.slice(1).join('\n');
			const items = __kustoPrettifyWhereClause([after, rest].filter(Boolean).join('\n'));
			let emittedFirst = false;
			const pendingComments = [];
			const emitPendingComments = () => {
				for (const c of pendingComments.splice(0, pendingComments.length)) {
					out.push('    ' + String(c || '').trim());
				}
			};
			for (const it of items) {
				if (!it) continue;
				if (it.type === 'comment') {
					// Group the comment with the next condition line by emitting it right before the next cond.
					pendingComments.push(String(it.text || '').trim());
					continue;
				}
				if (it.type === 'cond') {
					emitPendingComments();
					if (!emittedFirst) {
						out.push('| where ' + it.text);
						emittedFirst = true;
					} else {
						const op = String(it.op || 'and').toLowerCase();
						out.push('    ' + op + ' ' + it.text);
					}
				}
			}
			// If we ended with dangling comments, keep them at the end of the where block.
			emitPendingComments();
			if (!emittedFirst) {
				out.push('| where');
			}
			i = j;
			continue;
		}

		{
			const m = trimmed.match(/^\|\s*(extend|project|project-away|project-keep|project-rename|project-reorder|project-smart|distinct)\b/i);
			if (m) {
				const clause = String(m[1] || '').toLowerCase();
				const block = [];
				let j = i;
				for (; j < lines.length; j++) {
					const t = String(lines[j] || '').trim();
					if (j !== i && t.startsWith('|')) break;
					block.push(lines[j]);
				}
				const joined = block.join(' ').replace(/\s+/g, ' ').trim();
				const after = joined.replace(/^\|\s*[^\s]+\b/i, '').trim();
				const parts = __kustoSplitTopLevel(after, ',')
					.map((s) => String(s || '').trim())
					.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim())
					.filter(Boolean);
				if (parts.length <= 1) {
					const rest = [clause, after].filter(Boolean).join(' ');
					out.push('| ' + rest);
				} else {
					out.push('| ' + clause);
					for (let k = 0; k < parts.length; k++) {
						const comma = (k < parts.length - 1) ? ',' : '';
						out.push('    ' + parts[k] + comma);
					}
				}
				i = j;
				continue;
			}
		}

		if (isCreateFn) {
			// Format the header up to the opening '{' (if present).
			const block = [];
			let j = i;
			let foundBrace = false;
			for (; j < lines.length; j++) {
				block.push(lines[j]);
				if (String(lines[j] || '').includes('{')) {
					foundBrace = true;
					break;
				}
				// Stop at an empty line if we didn't find a brace (avoid eating whole file).
				if (j !== i && !String(lines[j] || '').trim()) break;
			}
			const headerText = block.join('\n');
			const formatted = (() => {
				try {
					const t = headerText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
					// Split at first '{' (outside of quotes) if possible.
					let braceIdx = -1;
					{
						let inS = false, inD = false;
						for (let bi = 0; bi < t.length; bi++) {
							const c = t[bi];
							if (!inD && c === "'") { const p = bi > 0 ? t[bi - 1] : ''; if (p !== '\\') inS = !inS; continue; }
							if (!inS && c === '"') { const p = bi > 0 ? t[bi - 1] : ''; if (p !== '\\') inD = !inD; continue; }
							if (!inS && !inD && c === '{') { braceIdx = bi; break; }
						}
					}
					const beforeBrace = braceIdx >= 0 ? t.slice(0, braceIdx).trim() : t.trim();
					const afterBrace = braceIdx >= 0 ? t.slice(braceIdx).trim() : '';

					// Handle optional with(...) section.
					const withIdx = __kustoFindTopLevelKeyword(beforeBrace, 'with');
					let headLine = beforeBrace;
					let withInner = '';
					let afterWith = '';
					if (withIdx >= 0) {
						const afterWithWord = beforeBrace.slice(withIdx + 4);
						const m = afterWithWord.match(/^\s*\(/);
						if (m) {
							headLine = beforeBrace.slice(0, withIdx).trim() + ' with (';
							// Extract paren contents.
							const rest = afterWithWord.slice(m[0].length);
							let depth = 1;
							let inS = false;
							let inD = false;
							let k = 0;
							for (; k < rest.length; k++) {
								const c = rest[k];
								const prev = k > 0 ? rest[k - 1] : '';
								if (!inD && c === "'") { if (prev !== '\\') inS = !inS; continue; }
								if (!inS && c === '"') { if (prev !== '\\') inD = !inD; continue; }
								if (inS || inD) continue;
								if (c === '(') depth++;
								else if (c === ')') {
									depth--;
									if (depth === 0) { k++; break; }
								}
							}
							withInner = rest.slice(0, Math.max(0, k - 1));
							afterWith = rest.slice(k).trim();
						}
					}

					const outLines = [];
					outLines.push(headLine);
					if (withInner) {
						const props = __kustoSplitTopLevel(withInner, ',')
							.map((s) => String(s || '').trim())
							.filter(Boolean);
						for (let pi = 0; pi < props.length; pi++) {
							const comma = (pi < props.length - 1) ? ',' : '';
							outLines.push('    ' + props[pi].replace(/,$/, '').trim() + comma);
						}
						outLines.push(')');
					}

					// Format function signature (after with-section or directly after header).
					const sigText = String(afterWith || (withIdx < 0 ? beforeBrace : '')).trim();
					if (sigText) {
						// Find name(...)
						const openIdx = sigText.indexOf('(');
						if (openIdx > 0) {
							const name = sigText.slice(0, openIdx).trim();
							const rest = sigText.slice(openIdx + 1);
							// Extract params until matching ')'
							let depth = 1;
							let inS = false;
							let inD = false;
							let k = 0;
							for (; k < rest.length; k++) {
								const c = rest[k];
								const prev = k > 0 ? rest[k - 1] : '';
								if (!inD && c === "'") { if (prev !== '\\') inS = !inS; continue; }
								if (!inS && c === '"') { if (prev !== '\\') inD = !inD; continue; }
								if (inS || inD) continue;
								if (c === '(') depth++;
								else if (c === ')') {
									depth--;
									if (depth === 0) { k++; break; }
								}
							}
							const inner = rest.slice(0, Math.max(0, k - 1));
							outLines.push('    ' + name + '(');
							const params = __kustoSplitTopLevel(inner, ',')
								.map((s) => String(s || '').trim())
								.filter(Boolean);
							for (let pi = 0; pi < params.length; pi++) {
								const comma = (pi < params.length - 1) ? ',' : '';
								outLines.push('        ' + params[pi].replace(/,$/, '').trim() + comma);
							}
							outLines.push('    )');
						} else {
							outLines.push('    ' + sigText);
						}
					}

					if (afterBrace) {
						outLines.push(afterBrace);
					}
					return outLines.join('\n');
				} catch {
					return headerText;
				}
			})();
			out.push(...String(formatted).split('\n').map((l) => String(l).replace(/[ \t]+$/g, '')));
			i = j + 1;
			continue;
		}

		// Default: normalize pipe prefix spacing.
		if (isPipe) {
			out.push('| ' + trimmed.replace(/^\|\s*/, ''));
		} else {
			out.push(trimmed);
		}
		i++;
	}

	// Indent pipeline clauses under the initial expression/table line.
	// Example:
	//   Table
	//       | where ...
	//           and ...
	try {
		const firstIdx = out.findIndex((l) => String(l || '').trim().length > 0);
		if (firstIdx >= 0 && !String(out[firstIdx] || '').trim().startsWith('|')) {
			const baseIndentMatch = String(out[firstIdx] || '').match(/^\s*/);
			const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
			const pipeIndent = baseIndent + '    ';
			let inPipeline = false;
			for (let j = firstIdx + 1; j < out.length; j++) {
				const line = String(out[j] ?? '');
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				if (trimmed.startsWith('|')) {
					out[j] = pipeIndent + trimmed;
					inPipeline = true;
					continue;
				}
				// Continuation lines emitted by prettifier for where/summarize blocks.
				if (inPipeline && /^ {4}/.test(line)) {
					out[j] = pipeIndent + line;
					continue;
				}
				// New top-level statement.
				inPipeline = false;
			}
		}
	} catch { /* ignore */ }

	// Trim leading/trailing blank lines.
	while (out.length && !String(out[0]).trim()) out.shift();
	while (out.length && !String(out[out.length - 1]).trim()) out.pop();
	return out.join('\n');
}

function __kustoSplitKustoStatementsBySemicolon(text) {
	const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	/** @type {{ statement: string, hasSemicolonAfter: boolean }[]} */
	const segments = [];
	let start = 0;
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const next = (i + 1 < raw.length) ? raw[i + 1] : '';
		const prev = (i > 0) ? raw[i - 1] : '';

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (!inSingle && !inDouble) {
			if (ch === '/' && next === '/') {
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i++;
				continue;
			}
		}

		if (!inDouble && ch === "'") {
			if (prev !== '\\') inSingle = !inSingle;
			continue;
		}
		if (!inSingle && ch === '"') {
			if (prev !== '\\') inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble && ch === ';') {
			segments.push({ statement: raw.slice(start, i), hasSemicolonAfter: true });
			start = i + 1;
		}
	}
	segments.push({ statement: raw.slice(start), hasSemicolonAfter: false });
	return segments;
}

function __kustoPrettifyKustoTextWithSemicolonStatements(text) {
	const raw = String(text ?? '');
	const segments = __kustoSplitKustoStatementsBySemicolon(raw);
	const hasMultipleStatements = segments.some((s) => s && s.hasSemicolonAfter);
	if (!hasMultipleStatements) {
		// Preserve exact behavior for single-statement queries.
		return __kustoPrettifyKusto(raw);
	}

	const outLines = [];
	for (const seg of segments) {
		if (!seg) continue;
		const statementText = String(seg.statement ?? '');
		const formattedStatement = (() => {
			// Avoid calling the formatter on pure-whitespace fragments.
			if (!statementText.trim()) return '';
			try {
				return __kustoPrettifyKusto(statementText);
			} catch {
				return statementText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
			}
		})();
		if (formattedStatement) {
			outLines.push(...String(formattedStatement).split('\n'));
		}
		if (seg.hasSemicolonAfter) {
			outLines.push(';');
		}
	}

	// Trim leading/trailing blank lines.
	while (outLines.length && !String(outLines[0]).trim()) outLines.shift();
	while (outLines.length && !String(outLines[outLines.length - 1]).trim()) outLines.pop();
	return outLines.join('\n');
}

function __kustoIsElementVisibleForSuggest(el) {
	try {
		if (!el) return false;
		// Most Monaco builds keep `aria-hidden` in sync.
		try {
			const ariaHidden = String((el.getAttribute && el.getAttribute('aria-hidden')) || '').toLowerCase();
			if (ariaHidden === 'true') return false;
		} catch { /* ignore */ }
		try {
			const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : null;
			if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return false;
		} catch { /* ignore */ }
		try {
			if (el.getClientRects && el.getClientRects().length === 0) return false;
		} catch { /* ignore */ }
		return true;
	} catch {
		return false;
	}
}

function __kustoGetWordNearCursor(ed) {
	try {
		if (!ed) return '';
		const model = ed.getModel && ed.getModel();
		const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
		if (!model || !pos) return '';

		const lineNumber = Number(pos.lineNumber) || 0;
		const column = Number(pos.column) || 0;
		if (lineNumber <= 0 || column <= 0) return '';

		const tryWordAtColumn = (col) => {
			try {
				const c = Number(col) || 0;
				if (c <= 0) return '';
				if (typeof model.getWordAtPosition !== 'function') return '';
				const w = model.getWordAtPosition({ lineNumber, column: c });
				const word = w && typeof w.word === 'string' ? w.word : '';
				return String(word || '').trim();
			} catch {
				return '';
			}
		};

		// Normal case: caret is inside a word.
		let word = tryWordAtColumn(column);
		if (word) return word;

		// Boundary case: caret is right *before* the first character of a word.
		word = tryWordAtColumn(column + 1);
		if (word) return word;

		// Boundary case: caret is right *after* the last character of a word.
		word = tryWordAtColumn(column - 1);
		if (word) return word;

		// Robust fallback: inspect the line text (fast and avoids Monaco quirks at boundaries).
		try {
			if (typeof model.getLineContent !== 'function') return '';
			const line = String(model.getLineContent(lineNumber) || '');
			if (!line) return '';

			const isWordCh = (c) => /[A-Za-z0-9_]/.test(String(c || ''));
			let idx = Math.max(0, column - 1);
			if (idx >= line.length) idx = line.length - 1;
			if (idx < 0) return '';

			// If we're sitting on whitespace, allow a small bounded lookahead (covers "caret before word"
			// including cases with multiple spaces/tabs).
			try {
				if (!isWordCh(line[idx]) && /\s/.test(String(line[idx] || ''))) {
					let j = idx;
					while (j < line.length && /\s/.test(String(line[j] || '')) && (j - idx) < 24) j++;
					if (j < line.length) idx = j;
				}
			} catch { /* ignore */ }

			// If char under idx isn't a word char but the left char is, treat it as end-of-word.
			if (!isWordCh(line[idx]) && idx > 0 && isWordCh(line[idx - 1])) {
				idx = idx - 1;
			}
			if (!isWordCh(line[idx])) return '';

			let start = idx;
			let end = idx;
			while (start > 0 && isWordCh(line[start - 1])) start--;
			while (end + 1 < line.length && isWordCh(line[end + 1])) end++;
			return String(line.slice(start, end + 1) || '').trim();
		} catch {
			return '';
		}
	} catch {
		return '';
	}
}

function __kustoFindSuggestWidgetForEditor(ed, opts) {
	try {
		const options = opts || {};
		const requireVisible = options.requireVisible !== false;
		const maxDistancePx = (typeof options.maxDistancePx === 'number') ? options.maxDistancePx : 320;

		const root = (ed && typeof ed.getDomNode === 'function') ? ed.getDomNode() : null;
		const editorHost = (() => {
			try {
				if (!root) return null;
				// Prefer the actual Monaco root so we can scope queries when multiple editors exist.
				return (root.closest && root.closest('.monaco-editor')) ? root.closest('.monaco-editor') : root;
			} catch {
				return root;
			}
		})();
		const doc = (root && root.ownerDocument) ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
		if (!doc || typeof doc.querySelectorAll !== 'function') return null;

		// Compute a client point near the caret for "which widget is mine" selection.
		let anchorX = 0;
		let anchorY = 0;
		try {
			const r = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
			anchorX = r ? (r.left + Math.max(0, (r.width || 0) / 2)) : 0;
			anchorY = r ? (r.top + Math.max(0, (r.height || 0) / 2)) : 0;
			const pos = (ed && typeof ed.getPosition === 'function') ? ed.getPosition() : null;
			const rel = (pos && typeof ed.getScrolledVisiblePosition === 'function') ? ed.getScrolledVisiblePosition(pos) : null;
			if (r && rel && typeof rel.left === 'number' && typeof rel.top === 'number') {
				anchorX = r.left + rel.left + 8;
				anchorY = r.top + rel.top + (typeof rel.height === 'number' ? rel.height : 0) + 2;
			}
		} catch { /* ignore */ }

		// IMPORTANT:
		// With multiple editors on the same page, querying the whole document can pick the wrong
		// suggest widget (e.g. from another editor) and cause preselect/auto-hide logic to behave
		// inconsistently. Prefer scoping to this editor's DOM subtree first.
		let widgets = null;
		try {
			if (editorHost && typeof editorHost.querySelectorAll === 'function') {
				widgets = editorHost.querySelectorAll('.suggest-widget');
			}
		} catch { widgets = null; }
		if (!widgets || !widgets.length) {
			try {
				widgets = doc.querySelectorAll('.suggest-widget');
			} catch { widgets = null; }
		}
		if (!widgets || !widgets.length) return null;
		let best = null;
		let bestDist2 = Infinity;
		for (const w of widgets) {
			if (!w || !w.getBoundingClientRect) continue;
			// If we had to fall back to a document-wide scan, try to keep the selection within
			// the current editor's Monaco root when possible.
			try {
				if (editorHost && w.closest) {
					const wHost = w.closest('.monaco-editor');
					if (wHost && wHost !== editorHost) continue;
				}
			} catch { /* ignore */ }
			if (requireVisible && !__kustoIsElementVisibleForSuggest(w)) continue;
			const rect = w.getBoundingClientRect();
			// distance from point to rect (0 if inside)
			const dx = (anchorX < rect.left) ? (rect.left - anchorX) : (anchorX > rect.right) ? (anchorX - rect.right) : 0;
			const dy = (anchorY < rect.top) ? (rect.top - anchorY) : (anchorY > rect.bottom) ? (anchorY - rect.bottom) : 0;
			const d2 = (dx * dx) + (dy * dy);
			if (d2 < bestDist2) {
				bestDist2 = d2;
				best = w;
			}
		}
		if (!best) return null;
		if (isFinite(bestDist2) && maxDistancePx > 0) {
			const max2 = maxDistancePx * maxDistancePx;
			if (bestDist2 > max2) return null;
		}
		return best;
	} catch {
		return null;
	}
}

function __kustoRegisterGlobalSuggestMutationHandler(doc, handler) {
	try {
		if (!doc || !handler) return () => { };
		const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
		if (!win) return () => { };

		if (!win.__kustoSuggestMutationHub) {
			const hub = {
				handlers: new Set(),
				mo: null,
				scheduled: false,
				schedule() {
					if (hub.scheduled) return;
					hub.scheduled = true;
					const run = () => {
						hub.scheduled = false;
						try {
							for (const h of Array.from(hub.handlers)) {
								try { h(); } catch { /* ignore */ }
							}
						} catch { /* ignore */ }
					};
					try {
						requestAnimationFrame(run);
					} catch {
						setTimeout(run, 0);
					}
				}
			};
			try {
				if (typeof MutationObserver !== 'undefined' && doc.body) {
					hub.mo = new MutationObserver(() => hub.schedule());
					hub.mo.observe(doc.body, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ['aria-hidden', 'class', 'style']
					});
				}
			} catch { hub.mo = null; }
			win.__kustoSuggestMutationHub = hub;
		}

		const hub = win.__kustoSuggestMutationHub;
		try { hub.handlers.add(handler); } catch { /* ignore */ }
		try { hub.schedule(); } catch { /* ignore */ }

		return () => {
			try { hub.handlers.delete(handler); } catch { /* ignore */ }
			try {
				if (hub.handlers.size === 0 && hub.mo) {
					hub.mo.disconnect();
					hub.mo = null;
				}
			} catch { /* ignore */ }
		};
	} catch {
		return () => { };
	}
}

function __kustoInstallSmartSuggestWidgetSizing(editor) {
	try {
		if (!editor) return () => { };

		// Minimal behavior: when suggest becomes visible, preselect the matching item once.
		// After that, do not interact with the suggest list/widget at all; let Monaco own it.
		// This avoids destabilizing Monaco suggest rendering across multiple editors.
		const minimalDispose = (() => {
			const safeTrigger = (ed, commandId) => {
				try {
					if (!ed || !commandId) return;
					const result = ed.trigger('keyboard', commandId, {});
					if (result && typeof result.then === 'function') {
						result.catch(() => { /* ignore */ });
					}
				} catch { /* ignore */ }
			};

			const getEditorDomMinimal = () => {
				try {
					return (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
				} catch {
					return null;
				}
			};

			// Keep existing call sites safe, but intentionally no-op.
			try { editor.__kustoScheduleSuggestClamp = () => { }; } catch { /* ignore */ }
			// IMPORTANT: keep existing call sites safe, but prevent preselect from being
			// retriggered on arrow/cursor navigation.
			try { editor.__kustoScheduleSuggestPreselect = () => { }; } catch { /* ignore */ }

			let didPreselectThisOpen = false;
			let lastVisible = false;
			let preselectScheduled = false;
			let preselectAttemptsRemaining = 0;
			let targetWordAtOpen = '';

			const getWordAtCursor = () => {
				try {
					return __kustoGetWordNearCursor(editor);
				} catch {
					return '';
				}
			};

			const tryPreselectNow = () => {
				try {
					if (didPreselectThisOpen) return;
					if (typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') {
						didPreselectThisOpen = true;
						return;
					}
					const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent(targetWordAtOpen);
					if (did) {
						didPreselectThisOpen = true;
						return;
					}
					if (preselectAttemptsRemaining > 0) {
						preselectAttemptsRemaining--;
						schedulePreselectAttempt();
						return;
					}
					didPreselectThisOpen = true;
				} catch {
					didPreselectThisOpen = true;
				}
			};

			const schedulePreselectAttempt = () => {
				try {
					if (didPreselectThisOpen) return;
					if (preselectScheduled) return;
					preselectScheduled = true;
					requestAnimationFrame(() => {
						preselectScheduled = false;
						tryPreselectNow();
					});
				} catch {
					preselectScheduled = false;
					setTimeout(() => {
						preselectScheduled = false;
						tryPreselectNow();
					}, 0);
				}
			};

			const scheduleDelayedPreselectSweep = () => {
				// Some Monaco builds populate the suggest list asynchronously (and slower when unfiltered),
				// which disproportionately affects the "caret at start of word" scenario.
				// Do a few delayed sweeps, but stop as soon as we succeed.
				try {
					if (didPreselectThisOpen) return;
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch { /* ignore */ } }, 60);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch { /* ignore */ } }, 160);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch { /* ignore */ } }, 320);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch { /* ignore */ } }, 650);
				} catch { /* ignore */ }
			};

			const checkSuggestVisibilityTransition = () => {
				try {
					const widget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: false, maxDistancePx: 320 });
					let visible = !!(widget && __kustoIsElementVisibleForSuggest(widget));
					if (!visible) {
						lastVisible = false;
						didPreselectThisOpen = false;
						targetWordAtOpen = '';
						preselectAttemptsRemaining = 0;
						return;
					}
					if (!lastVisible) {
						lastVisible = true;
						targetWordAtOpen = getWordAtCursor();
						// Allow multiple frames + a few delayed sweeps for async suggest providers to populate rows.
						preselectAttemptsRemaining = 24;
						schedulePreselectAttempt();
						scheduleDelayedPreselectSweep();
					}
				} catch { /* ignore */ }
			};

			const scheduleHideSuggestIfTrulyBlurred = () => {
				try {
					setTimeout(() => {
						try {
							const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
							const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
							if (hasWidgetFocus || hasTextFocus) return;
						} catch { /* ignore */ }
						safeTrigger(editor, 'hideSuggestWidget');
					}, 150);
				} catch { /* ignore */ }
			};

			let disposables = [];
			const safeOn = (fn) => {
				try { if (fn && typeof fn.dispose === 'function') disposables.push(fn); } catch { /* ignore */ }
			};
			try { safeOn(editor.onDidBlurEditorText(() => scheduleHideSuggestIfTrulyBlurred())); } catch { /* ignore */ }
			try { safeOn(editor.onDidBlurEditorWidget(() => scheduleHideSuggestIfTrulyBlurred())); } catch { /* ignore */ }

			let mo = null;
			let unregister = null;
			try {
				const root = getEditorDomMinimal();
				const doc = (root && root.ownerDocument) ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
				unregister = __kustoRegisterGlobalSuggestMutationHandler(doc, checkSuggestVisibilityTransition);
			} catch {
				mo = null;
				unregister = null;
			}

			try { checkSuggestVisibilityTransition(); } catch { /* ignore */ }

			const dispose = () => {
				try { if (mo) mo.disconnect(); } catch { /* ignore */ }
				try { mo = null; } catch { /* ignore */ }
				try { if (typeof unregister === 'function') unregister(); } catch { /* ignore */ }
				try { unregister = null; } catch { /* ignore */ }
				try {
					for (const d of disposables) {
						try { d && d.dispose && d.dispose(); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
				disposables = [];
				try { delete editor.__kustoScheduleSuggestClamp; } catch { /* ignore */ }
				try { delete editor.__kustoScheduleSuggestPreselect; } catch { /* ignore */ }
			};

			try {
				if (typeof editor.onDidDispose === 'function') {
					editor.onDidDispose(() => dispose());
				}
			} catch { /* ignore */ }

			return dispose;
		})();

		return minimalDispose;

		const __kustoSafeEditorTrigger = (ed, commandId) => {
			try {
				if (!ed || !commandId) return;
				const result = ed.trigger('keyboard', commandId, {});
				// Some Monaco commands return a Promise; avoid unhandled rejections.
				if (result && typeof result.then === 'function') {
					result.catch(() => { /* ignore */ });
				}
			} catch {
				// ignore
			}
		};
		const getEditorDom = () => {
			try {
				return (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
			} catch {
				return null;
			}
		};
		const getWrapperDom = () => {
			try {
				const dom = getEditorDom();
				return (dom && dom.closest) ? dom.closest('.query-editor-wrapper') : null;
			} catch {
				return null;
			}
		};
		const getBoundsDom = () => {
			try {
				if (typeof editor.getContainerDomNode === 'function') {
					return editor.getContainerDomNode();
				}
			} catch { /* ignore */ }
			const dom = getEditorDom();
			return dom ? (dom.parentElement || dom) : null;
		};

		const getRowHeightPx = (suggestWidget) => {
			try {
				const row = suggestWidget && suggestWidget.querySelector
					? suggestWidget.querySelector('.monaco-list-row')
					: null;
				if (row) {
					const r = row.getBoundingClientRect();
					const h = Math.round(r.height || 0);
					if (h > 0) return h;
					const cs = getComputedStyle(row);
					const lh = Math.round(parseFloat(cs.height || cs.lineHeight || '0') || 0);
					if (lh > 0) return lh;
				}
			} catch {
				// ignore
			}
			// Monaco defaults are typically ~22px per row; keep a safe fallback.
			return 22;
		};

		// Use Monaco's supported configuration for suggest height when possible.
		// Fall back to DOM clamp + internal relayout poke only when needed.
		const DEFAULT_MAX_VISIBLE = 12;
		const MIN_DROPDOWN_PX = 50;
		let lastApplied = { availablePx: null, rowHeightPx: null, maxVisible: null };
		let pendingAdjustTimer = null;
		let rafScheduled = false;
		let lastRelayoutAt = 0;
		let lastAutoExpandAt = 0;
		let lastAutoExpandNeedPx = null;
		const clearInjectedSuggestStyles = (suggest) => {
			try {
				if (!suggest) return;
				// Clear any DOM sizing we might have applied in fallback mode.
				suggest.style.maxHeight = '';
				suggest.style.height = '';
				suggest.style.overflow = '';
				try {
					const injected = suggest.querySelectorAll
						? suggest.querySelectorAll('[data-kusto-suggest-clamp="1"]')
						: [];
					for (const el of injected) {
						try {
							el.style.height = '';
							el.style.maxHeight = '';
							el.style.overflowY = '';
							delete el.dataset.kustoSuggestClamp;
						} catch { /* ignore */ }
					}
				} catch { /* ignore */ }
			} catch { /* ignore */ }
		};

		const ensureMinimumDropdownSpace = (availablePx) => {
			try {
				const avail = Math.floor(Number(availablePx) || 0);
				if (!isFinite(avail)) return false;
				if (avail >= MIN_DROPDOWN_PX) return false;

				const need = Math.max(0, MIN_DROPDOWN_PX - avail);
				if (!need) return false;

				// Avoid tight loops if layout can't satisfy the requirement.
				try {
					const now = Date.now();
					if (now - lastAutoExpandAt < 150 && lastAutoExpandNeedPx === need) {
						return false;
					}
					lastAutoExpandAt = now;
					lastAutoExpandNeedPx = need;
				} catch { /* ignore */ }

				const wrapper = getWrapperDom();
				if (!wrapper || typeof wrapper.getBoundingClientRect !== 'function') return false;
				const current = Math.max(0, Math.round(wrapper.getBoundingClientRect().height || 0));
				if (!current) return false;

				const MIN_WRAPPER = 120;
				const MAX_WRAPPER = 900;
				const next = Math.max(MIN_WRAPPER, Math.min(MAX_WRAPPER, current + need));
				if (next <= current) return false;
				wrapper.style.height = next + 'px';

				// Help Monaco react immediately.
				try { editor.layout(); } catch { /* ignore */ }
				return true;
			} catch {
				return false;
			}
		};

		const applyDomClampFallback = (suggest, availablePx) => {
			try {
				if (!suggest) return;
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				if (!avail) return;
				// Keep this non-destructive: setting a hard `height` + `overflow:hidden` can
				// cause Monaco's internal list to render as an empty/blank box.
				suggest.style.maxHeight = avail + 'px';
				suggest.style.height = '';
				suggest.style.overflow = '';
				try {
					if (suggest.dataset) suggest.dataset.kustoSuggestClamp = '1';
				} catch { /* ignore */ }
			} catch {
				// ignore
			}
		};

		const applyListViewportClampFallback = (suggest, availablePx) => {
			// Some Monaco builds can end up with a visible suggest widget whose internal list viewport
			// collapses (scrollbar present but rows not painted). Apply a height to the list container
			// as a last-resort recovery.
			try {
				if (!suggest) return;
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				if (!avail) return;
				const overheadPx = 14;
				const h = Math.max(1, avail - overheadPx);
				let list = null;
				try { list = suggest.querySelector && suggest.querySelector('.monaco-list'); } catch { list = null; }
				if (!list) {
					try {
						const rows = suggest.querySelector && suggest.querySelector('.monaco-list-rows');
						list = rows && rows.parentElement ? rows.parentElement : null;
					} catch { list = null; }
				}
				if (!list) return;
				list.style.height = h + 'px';
				list.style.maxHeight = h + 'px';
				try { if (list.dataset) list.dataset.kustoSuggestClamp = '1'; } catch { /* ignore */ }
			} catch {
				// ignore
			}
		};

		let lastForceBelowKey = '';
		let lastForceBelowAt = 0;
		const tryForceSuggestBelowCaret = () => {
			// When Monaco decides to render the suggest widget above the caret (common when the
			// editor viewport is short), it can overlap our internal toolbar. If we detect that,
			// expand the wrapper if needed and re-open suggest so Monaco takes the below-caret path.
			try {
				const pos = (typeof editor.getPosition === 'function') ? editor.getPosition() : null;
				const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
				const versionId = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
				const key = String(versionId || '') + ':' + String(pos ? pos.lineNumber : '') + ':' + String(pos ? pos.column : '');
				const now = Date.now();
				if (key && key === lastForceBelowKey && (now - lastForceBelowAt) < 400) {
					return;
				}
				lastForceBelowKey = key;
				lastForceBelowAt = now;

				// Ensure we have some room below; if not, grow the wrapper.
				try {
					const cursor = (pos && typeof editor.getScrolledVisiblePosition === 'function')
						? editor.getScrolledVisiblePosition(pos)
						: null;
					const layout = (typeof editor.getLayoutInfo === 'function') ? editor.getLayoutInfo() : null;
					if (cursor && layout && typeof layout.height === 'number') {
						const pad = 8;
						let availableBelowPx = Math.floor((layout.height || 0) - (cursor.top || 0) - (cursor.height || 0) - pad);
						if (!isFinite(availableBelowPx)) availableBelowPx = 0;
						// Reuse the same minimum threshold we use elsewhere.
						if (availableBelowPx < MIN_DROPDOWN_PX) {
							ensureMinimumDropdownSpace(availableBelowPx);
						}
						// Nudge maxVisibleSuggestions down so the below-caret option becomes viable.
						const rowHeightPx = 22;
						const overheadPx = 16;
						const usable = Math.max(0, Math.max(availableBelowPx, MIN_DROPDOWN_PX) - overheadPx);
						const maxVisible = Math.max(1, Math.floor(usable / Math.max(1, rowHeightPx)));
						applyMaxVisibleSuggestions(maxVisible);
					}
				} catch { /* ignore */ }

				try { editor.layout(); } catch { /* ignore */ }
				// IMPORTANT: do NOT auto-trigger suggestions here.
				// If Monaco placed the widget outside bounds (e.g. into the toolbar), close it.
				// The next user-triggered suggest (Ctrl+Space / toolbar) will open with the updated layout.
				__kustoSafeEditorTrigger(editor, 'hideSuggestWidget');
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
			} catch {
				// ignore
			}
		};

		const scheduleHideSuggestIfTrulyBlurred = () => {
			try {
				// Avoid closing suggest during Monaco's internal focus churn while opening/closing widgets.
				setTimeout(() => {
					try {
						const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
						const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
						if (hasWidgetFocus || hasTextFocus) {
							return;
						}
					} catch {
						// ignore
					}
					__kustoSafeEditorTrigger(editor, 'hideSuggestWidget');
				}, 150);
			} catch {
				// ignore
			}
		};

		let lastSuggestVisible = false;
		let suggestListObserver = null;
		let suggestPreselectRaf = false;
		let lastPreselectAt = 0;
		let lastPreselectTargetLower = '';
		let lastPreselectFocusedLower = '';
		let cursorClampTimer = null;
		let lastCursorClampAt = 0;
		const debugSuggest = (eventName, data) => {
			try {
				const enabled = !!(window && (window.__kustoSuggestDebug || (window.localStorage && window.localStorage.getItem('kustoSuggestDebug') === '1')));
				if (!enabled) return;
				// eslint-disable-next-line no-console
				console.debug('[kusto][suggest]', String(eventName || ''), data || {}, { boxId: editor && editor.__kustoBoxId });
			} catch {
				// ignore
			}
		};
		const normalizeSuggestLabel = (s) => {
			try {
				let x = String(s || '').trim();
				x = x.replace(/^(\[|\(|\{|"|')+/, '').replace(/(\]|\)|\}|"|')+$/, '');
				x = x.split(/[\s,\(]/g).filter(Boolean)[0] || x;
				return String(x || '').trim();
			} catch {
				return String(s || '').trim();
			}
		};
		const getFocusedSuggestRowLabelLower = () => {
			try {
				const root = getEditorDom();
				if (!root || typeof root.querySelector !== 'function') return '';
				const widget = root.querySelector('.suggest-widget');
				if (!widget || typeof widget.querySelector !== 'function') return '';
				const ariaHidden = String((widget.getAttribute && widget.getAttribute('aria-hidden')) || '').toLowerCase();
				if (ariaHidden === 'true') return '';
				const row = widget.querySelector('.monaco-list-row.focused') || widget.querySelector('.monaco-list-row[aria-selected="true"]');
				if (!row) return '';
				let label = '';
				try {
					const labelName = row.querySelector && row.querySelector('.label-name');
					if (labelName && typeof labelName.textContent === 'string') {
						label = labelName.textContent;
					}
				} catch { /* ignore */ }
				if (!label) {
					try {
						label = String((row.getAttribute && row.getAttribute('aria-label')) || '');
					} catch { /* ignore */ }
				}
				label = normalizeSuggestLabel(label);
				return String(label || '').toLowerCase();
			} catch {
				return '';
			}
		};
		const scheduleSuggestPreselect = () => {
			if (suggestPreselectRaf) return;
			// Throttle: repeated DOM mutations + cursor moves can happen during filtering.
			const now = Date.now();
			if (now - lastPreselectAt < 60) return;
			lastPreselectAt = now;
			suggestPreselectRaf = true;
			try {
				requestAnimationFrame(() => {
					suggestPreselectRaf = false;
					try {
						if (!editor || typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') return;
						// Skip if the focused item already matches the current target.
						let focusedLower = '';
						try { focusedLower = getFocusedSuggestRowLabelLower(); } catch { focusedLower = ''; }
						if (focusedLower) {
							lastPreselectFocusedLower = focusedLower;
						}
						// If focus hasn't changed and last target is the same, don't touch Monaco.
						if (focusedLower && lastPreselectTargetLower && focusedLower === lastPreselectTargetLower) {
							return;
						}
						const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent();
						if (did) {
							// Refresh focused label cache after we changed it.
							try { lastPreselectFocusedLower = getFocusedSuggestRowLabelLower(); } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
				});
			} catch {
				suggestPreselectRaf = false;
				setTimeout(() => {
					try {
						if (!editor || typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') return;
						const focusedLower = getFocusedSuggestRowLabelLower();
						if (focusedLower && lastPreselectTargetLower && focusedLower === lastPreselectTargetLower) {
							return;
						}
						const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent();
						if (did) {
							try { lastPreselectFocusedLower = getFocusedSuggestRowLabelLower(); } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
				}, 0);
			}
		};
		try { editor.__kustoScheduleSuggestPreselect = scheduleSuggestPreselect; } catch { /* ignore */ }

		const tryRelayoutSuggestWidget = (availablePx) => {
			// Best-effort poke of Monaco internals so keyboard navigation uses the updated height.
			// All accesses are optional and guarded.
			try {
				const now = Date.now();
				if (now - lastRelayoutAt < 16) return;
				lastRelayoutAt = now;
			} catch { /* ignore */ }
			try {
				if (!editor || typeof editor.getContribution !== 'function') return;
				const ctrl = editor.getContribution('editor.contrib.suggestController');
				if (!ctrl) return;

				const candidates = [];
				try { if (ctrl._widget) candidates.push(ctrl._widget); } catch { /* ignore */ }
				try { if (ctrl.widget) candidates.push(ctrl.widget); } catch { /* ignore */ }
				try { if (ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch { /* ignore */ }
				try { if (ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch { /* ignore */ }

				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				for (const w0 of candidates) {
					const w = (w0 && w0.value) ? w0.value : w0;
					if (!w) continue;
					try {
						if (typeof w.layout === 'function') {
							// Some implementations accept (dimension) or no args.
							try { w.layout(); } catch { /* ignore */ }
							try { if (avail) w.layout({ height: avail }); } catch { /* ignore */ }
							try { if (avail) w.layout(avail); } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
					try { if (typeof w._layout === 'function') w._layout(); } catch { /* ignore */ }
					try { if (typeof w._resize === 'function') w._resize(); } catch { /* ignore */ }
					try { if (w._tree && typeof w._tree.layout === 'function' && avail) w._tree.layout(avail); } catch { /* ignore */ }
					try { if (w._list && typeof w._list.layout === 'function' && avail) w._list.layout(avail); } catch { /* ignore */ }
				}
			} catch {
				// ignore
			}
		};

		const applyMaxVisibleSuggestions = (maxVisible) => {
			try {
				const mv = Math.max(1, Math.floor(Number(maxVisible) || 0));
				if (lastApplied.maxVisible === mv) {
					return;
				}
				lastApplied.maxVisible = mv;
				// Monaco supports nested updateOptions for suggest.
				// Keep other suggest config untouched.
				editor.updateOptions({ suggest: { maxVisibleSuggestions: mv } });
			} catch {
				// ignore
			}
		};

		const computeMaxVisibleFromAvailablePx = (availablePx, rowHeightPx) => {
			try {
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				const rh = Math.max(1, Math.floor(Number(rowHeightPx) || 0));
				// Suggest widget has borders/padding/header; subtract a small constant overhead.
				const overhead = 12;
				const usable = Math.max(0, avail - overhead);
				return Math.max(1, Math.floor(usable / rh));
			} catch {
				return 1;
			}
		};

		const schedulePostLayoutAdjust = (root, boundsDom, suggest) => {
			try {
				if (pendingAdjustTimer) return;
				pendingAdjustTimer = setTimeout(() => {
					pendingAdjustTimer = null;
					try {
						if (!root || !boundsDom || !suggest) return;
						const ariaHidden = String((suggest.getAttribute && suggest.getAttribute('aria-hidden')) || '').toLowerCase();
						if (ariaHidden === 'true') return;
						const boundsRect = boundsDom.getBoundingClientRect();
						const suggestRect = suggest.getBoundingClientRect();
						const pad = 4;
						// Handle bottom overflow.
						const overflow = Math.ceil((suggestRect.bottom || 0) - ((boundsRect.bottom || 0) - pad));
						// Handle top overflow (common when Monaco chooses above-caret placement).
						const topOverflow = Math.ceil(((boundsRect.top || 0) + pad) - (suggestRect.top || 0));

						if ((!isFinite(overflow) || overflow <= 0) && (!isFinite(topOverflow) || topOverflow <= 0)) {
							return;
						}

						const rowHeight = getRowHeightPx(suggest);
						let next = lastApplied.maxVisible || DEFAULT_MAX_VISIBLE;
						try {
							if (isFinite(overflow) && overflow > 0) {
								const reduceBy = Math.max(1, Math.ceil(overflow / Math.max(1, rowHeight)));
								next = Math.max(1, next - reduceBy);
							}
							if (isFinite(topOverflow) && topOverflow > 0) {
								const reduceByTop = Math.max(1, Math.ceil(topOverflow / Math.max(1, rowHeight)));
								next = Math.max(1, next - reduceByTop);
							}
						} catch { /* ignore */ }
						applyMaxVisibleSuggestions(next);
						// If Monaco still overflows, apply DOM clamp and relayout as a fallback.
						try {
							const boundsRect2 = boundsDom.getBoundingClientRect();
							const suggestRect2 = suggest.getBoundingClientRect();
							let availablePx = Math.floor((boundsRect2.bottom || 0) - (suggestRect2.top || 0) - pad);
							// If it's anchored above the caret, clamp to available space above instead.
							if (isFinite(topOverflow) && topOverflow > 0) {
								availablePx = Math.floor((suggestRect2.bottom || 0) - (boundsRect2.top || 0) - pad);
							}
							if (isFinite(availablePx) && availablePx > 0 && (suggestRect2.height || 0) > availablePx + 2) {
								applyDomClampFallback(suggest, availablePx);
								tryRelayoutSuggestWidget(availablePx);
							}
						} catch { /* ignore */ }
					} catch { /* ignore */ }
				}, 0);
			} catch {
				pendingAdjustTimer = null;
			}
		};

		const clampNow = () => {
			rafScheduled = false;
			try {
				const root = getEditorDom();
				if (!root || typeof root.querySelector !== 'function') return;
				const boundsDom = getBoundsDom();
				if (!boundsDom || typeof boundsDom.getBoundingClientRect !== 'function') return;
				const suggest = root.querySelector('.suggest-widget');
				if (!suggest || typeof suggest.getBoundingClientRect !== 'function') return;

				// Only apply when visible.
				const ariaHidden = String((suggest.getAttribute && suggest.getAttribute('aria-hidden')) || '').toLowerCase();
				const isVisible = ariaHidden !== 'true';
				if (!isVisible) {
					try { lastSuggestVisible = false; } catch { /* ignore */ }
					try { if (suggestListObserver) suggestListObserver.disconnect(); } catch { /* ignore */ }
					try { suggestListObserver = null; } catch { /* ignore */ }
					// When hidden, clear any fallback styles we may have applied.
					clearInjectedSuggestStyles(suggest);
					// When hidden, keep lastApplied.maxVisible; we'll recompute on next open.
					return;
				}

				// The moment suggest becomes visible (or its rows change), try to preselect immediately.
				try {
					if (!lastSuggestVisible) {
						lastSuggestVisible = true;
						try { lastPreselectTargetLower = ''; } catch { /* ignore */ }
						try { lastPreselectFocusedLower = ''; } catch { /* ignore */ }
						scheduleSuggestPreselect();
					}
					// Observe list population/updates while visible; preselect is throttled + guarded.
					if (!suggestListObserver && typeof MutationObserver !== 'undefined') {
						suggestListObserver = new MutationObserver(() => {
							scheduleSuggestPreselect();
						});
						// Watch for list population/updates; avoid attribute watching to prevent hover flicker.
						suggestListObserver.observe(suggest, { subtree: true, childList: true });
					}
				} catch { /* ignore */ }

				// Clear any fallback styles only if we previously applied them.
				try {
					const hadClamp = (suggest.dataset && suggest.dataset.kustoSuggestClamp === '1')
						|| !!(suggest.querySelector && suggest.querySelector('[data-kusto-suggest-clamp="1"]'));
					if (hadClamp) {
						clearInjectedSuggestStyles(suggest);
					}
				} catch { /* ignore */ }

				const boundsRect = boundsDom.getBoundingClientRect();
				const suggestRect = suggest.getBoundingClientRect();
				const pad = 4;
				const topOverflow = Math.ceil(((boundsRect.top || 0) + pad) - (suggestRect.top || 0));
				let availablePx = 0;
				// If Monaco chose above-caret placement and it overflows at the top of the editor,
				// clamp based on the available space ABOVE (bounds.top .. suggest.bottom).
				if (isFinite(topOverflow) && topOverflow > 0) {
					availablePx = Math.floor((suggestRect.bottom || 0) - (boundsRect.top || 0) - pad);
				} else {
					// Default: clamp based on the available space below the widget's top.
					availablePx = Math.floor((boundsRect.bottom || 0) - (suggestRect.top || 0) - pad);
				}
				if (!isFinite(availablePx) || availablePx <= 0) {
					return;
				}

				// If the internal list viewport collapsed (common "empty but scrollable" crash), recover before sizing.
				try {
					const list = suggest.querySelector && (suggest.querySelector('.monaco-list') || (suggest.querySelector('.monaco-list-rows') && suggest.querySelector('.monaco-list-rows').parentElement));
					if (list) {
						const clientH = Math.floor(list.clientHeight || 0);
						const scrollH = Math.floor(list.scrollHeight || 0);
						if (scrollH > 0 && clientH <= 1) {
							debugSuggest('listViewportCollapsed', { clientH, scrollH });
							applyListViewportClampFallback(suggest, availablePx);
							tryRelayoutSuggestWidget(availablePx);
						}
					}
				} catch { /* ignore */ }

				// If the dropdown would be too small, expand the whole editor section so we can
				// always show a usable menu (minimum 50px). Only applicable to below-caret placement.
				try {
					if (!(isFinite(topOverflow) && topOverflow > 0)) {
						if (ensureMinimumDropdownSpace(availablePx)) {
							// Layout changed; recompute on next frame.
							scheduleClamp();
							return;
						}
					}
				} catch { /* ignore */ }

				const rowHeightPx = getRowHeightPx(suggest);
				const maxVisible = computeMaxVisibleFromAvailablePx(availablePx, rowHeightPx);
				if (lastApplied.availablePx !== availablePx || lastApplied.rowHeightPx !== rowHeightPx) {
					lastApplied.availablePx = availablePx;
					lastApplied.rowHeightPx = rowHeightPx;
				}
				applyMaxVisibleSuggestions(maxVisible);
				// If applying maxVisibleSuggestions doesn't affect actual widget height in this Monaco build,
				// clamp the DOM as a fallback and force a relayout so keyboard navigation uses the new viewport.
				try {
					if ((suggestRect.height || 0) > availablePx + 2) {
						applyDomClampFallback(suggest, availablePx);
						tryRelayoutSuggestWidget(availablePx);
					}
				} catch { /* ignore */ }
				// After Monaco applies the option, validate we didn't still overflow and reduce if needed.
				schedulePostLayoutAdjust(root, boundsDom, suggest);
			} catch {
				// ignore
			}
		};

		const scheduleClamp = () => {
			if (rafScheduled) return;
			rafScheduled = true;
			try {
				requestAnimationFrame(clampNow);
			} catch {
				setTimeout(clampNow, 0);
			}
		};

		let mo = null;
				try {
					const root = getEditorDom();
					if (root && typeof MutationObserver !== 'undefined') {
						mo = new MutationObserver(() => scheduleClamp());
						// Only watch aria-hidden so hover/selection class changes don't cause clamp loops.
						mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-hidden'] });
					}
				} catch {
			mo = null;
		}

		let disposables = [];
		const safeOn = (fn) => {
			try {
				if (fn && typeof fn.dispose === 'function') disposables.push(fn);
			} catch { /* ignore */ }
		};
		try { safeOn(editor.onDidLayoutChange(() => scheduleClamp())); } catch { /* ignore */ }
		try { safeOn(editor.onDidScrollChange(() => scheduleClamp())); } catch { /* ignore */ }
		try {
			safeOn(editor.onDidChangeCursorPosition(() => {
				try {
					// Cursor moves can happen for every arrow keypress; avoid thrashing Monaco suggest layout.
					if (cursorClampTimer) return;
					const now = Date.now();
					if (now - lastCursorClampAt < 120) return;
					cursorClampTimer = setTimeout(() => {
						cursorClampTimer = null;
						lastCursorClampAt = Date.now();
						try {
							const root = getEditorDom();
							const widget = root && root.querySelector ? root.querySelector('.suggest-widget') : null;
							const ariaHidden = String((widget && widget.getAttribute && widget.getAttribute('aria-hidden')) || '').toLowerCase();
							const isVisible = widget && ariaHidden !== 'true';
							if (isVisible) scheduleClamp();
						} catch { /* ignore */ }
					}, 120);
				} catch { /* ignore */ }
			}));
		} catch { /* ignore */ }
		try { safeOn(editor.onDidFocusEditorWidget(() => scheduleClamp())); } catch { /* ignore */ }
		try { safeOn(editor.onDidFocusEditorText(() => scheduleClamp())); } catch { /* ignore */ }
		// Prevent a suggest widget in one editor from lingering and stealing clicks/focus.
		try { safeOn(editor.onDidBlurEditorText(() => scheduleHideSuggestIfTrulyBlurred())); } catch { /* ignore */ }
		try { safeOn(editor.onDidBlurEditorWidget(() => scheduleHideSuggestIfTrulyBlurred())); } catch { /* ignore */ }

		// Install one global viewport listener to update all visible suggest widgets across editors.
		try {
			if (!window.__kustoSuggestWidgetViewportListenersInstalled) {
				window.__kustoSuggestWidgetViewportListenersInstalled = true;
				window.__kustoClampAllSuggestWidgets = () => {
					try {
						if (typeof queryEditors === 'undefined' || !queryEditors) return;
						for (const id of Object.keys(queryEditors)) {
							const ed = queryEditors[id];
							if (ed && typeof ed.__kustoScheduleSuggestClamp === 'function') {
								ed.__kustoScheduleSuggestClamp();
							}
						}
					} catch { /* ignore */ }
				};
				window.addEventListener('resize', () => {
					try { window.__kustoClampAllSuggestWidgets && window.__kustoClampAllSuggestWidgets(); } catch { /* ignore */ }
				});
				window.addEventListener('scroll', () => {
					try { window.__kustoClampAllSuggestWidgets && window.__kustoClampAllSuggestWidgets(); } catch { /* ignore */ }
				}, true);
			}
		} catch {
			// ignore
		}

		// Expose per-editor scheduler so the global listener can update all editors.
		try { editor.__kustoScheduleSuggestClamp = scheduleClamp; } catch { /* ignore */ }
		// Clamp once soon (handles cases where suggest widget is already open).
		scheduleClamp();

		const dispose = () => {
			try { if (mo) mo.disconnect(); } catch { /* ignore */ }
			try { mo = null; } catch { /* ignore */ }
			try { if (suggestListObserver) suggestListObserver.disconnect(); } catch { /* ignore */ }
			try { suggestListObserver = null; } catch { /* ignore */ }
			try {
				if (cursorClampTimer) {
					clearTimeout(cursorClampTimer);
					cursorClampTimer = null;
				}
			} catch { /* ignore */ }
			try { lastApplied = { availablePx: null, rowHeightPx: null, maxVisible: null }; } catch { /* ignore */ }
			try {
				if (pendingAdjustTimer) {
					clearTimeout(pendingAdjustTimer);
					pendingAdjustTimer = null;
				}
			} catch { /* ignore */ }
			try {
				for (const d of disposables) {
					try { d && d.dispose && d.dispose(); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			disposables = [];
			try { delete editor.__kustoScheduleSuggestClamp; } catch { /* ignore */ }
			try { delete editor.__kustoScheduleSuggestPreselect; } catch { /* ignore */ }
		};

		try {
			if (typeof editor.onDidDispose === 'function') {
				editor.onDidDispose(() => dispose());
			}
		} catch { /* ignore */ }

		return dispose;
	} catch {
		return () => { };
	}
}

function initQueryEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_query_editor');
		const wrapper = container && container.closest ? container.closest('.query-editor-wrapper') : null;
		const placeholder = document.getElementById(boxId + '_query_placeholder');
		const resizer = document.getElementById(boxId + '_query_resizer');
		if (!container) {
			return;
		}

		const updatePlaceholderPosition = () => {
			if (!placeholder) {
				return;
			}
			try {
				// The placeholder is absolutely positioned within .query-editor-wrapper.
				// Compute its position based on the Monaco container's actual on-screen
				// location so it stays correct even when the editor is nested (e.g. in
				// the Copilot split pane).
				if (!wrapper) {
					return;
				}
				const c = container.getBoundingClientRect();
				const w = wrapper.getBoundingClientRect();
				if (!c || !w) return;

				// Align to the first line number baseline (small +1px nudge).
				const top = (c.top - w.top) + 1;
				// Keep existing gutter offset behavior (56px) but relative to the editor's left.
				const left = (c.left - w.left) + 56;
				// Mirror the old right inset (10px) but relative to the editor's right.
				const right = (w.right - c.right) + 10;

				placeholder.style.top = Math.max(0, Math.round(top)) + 'px';
				placeholder.style.left = Math.max(0, Math.round(left)) + 'px';
				placeholder.style.right = Math.max(0, Math.round(right)) + 'px';
			} catch {
				// ignore
			}
		};

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

		// If persistence restore ran before Monaco init, apply the restored wrapper height now.
		// This avoids layout glitches when the Copilot split-pane is installed.
		try {
			const pending = window.__kustoPendingWrapperHeightPxByBoxId && window.__kustoPendingWrapperHeightPxByBoxId[boxId];
			if (typeof pending === 'number' && Number.isFinite(pending) && pending > 0) {
				let w = wrapper;
				if (!w) {
					const box = document.getElementById(boxId);
					w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
				}
				if (w) {
					w.style.height = Math.round(pending) + 'px';
					try { w.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
				}
				try { delete window.__kustoPendingWrapperHeightPxByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

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
			// Reduce the blank gap between the line numbers and the code.
			// We rely on the line-decorations lane for the active-statement indicator, so keep it
			// non-zero but tight.
			glyphMargin: false,
			lineDecorationsWidth: 8,
			// Suggest (and other overflow widgets) can be mispositioned when Monaco is nested inside
			// multiple stacked, scrollable containers (e.g. the 3rd query box on screen).
			// Fixed overflow widgets use viewport-based geometry and are more reliable in VS Code webviews.
			fixedOverflowWidgets: true,
			// Monaco's built-in hover UI shows multiple stacked hover blocks (markers + providers)
			// and an action bar ("View Problem") that isn't useful in our webview.
			// We provide a single custom diagnostics tooltip instead.
			hover: { enabled: false },
			// Autocomplete should be manual-only (Ctrl+Space / toolbar) unless explicitly triggered by code.
			suggestOnTriggerCharacters: false,
			quickSuggestions: false,
			quickSuggestionsDelay: 0,
			// We don't use Monaco quick-fix/lightbulb UX in this webview.
			lightbulb: { enabled: false },
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Keep Monaco's suggest widget usable inside the editor bounds.
		try { __kustoInstallSmartSuggestWidgetSizing(editor); } catch { /* ignore */ }

		// Single diagnostics tooltip (replaces Monaco's default hover widget).
		try {
			const DIAG_OWNER = 'kusto-diagnostics';
			const DIAG_HOVER_SHOW_DELAY_MS = 1000;
			let diagHoverEl = null;
			let diagHoverLastKey = '';
			let diagHoverHideTimer = null;
			let diagHoverShowTimer = null;
			let diagHoverPending = null;
			let diagHoverLastMouse = { at: 0, clientX: 0, clientY: 0, position: null };
			let diagHoverLastCursor = { at: 0, position: null };
			let diagHoverActiveSource = null; // 'mouse' | 'cursor'

			const ensureDiagHoverEl = () => {
				if (diagHoverEl) return diagHoverEl;
				const el = document.createElement('div');
				el.className = 'kusto-doc-widget kusto-diagnostics-hover';
				el.style.position = 'fixed';
				el.style.display = 'none';
				el.style.pointerEvents = 'none';
				// Keep above the editor but below Monaco context widgets (quick fix / lightbulb menu).
				el.style.zIndex = '1000';
				document.body.appendChild(el);
				diagHoverEl = el;
				return el;
			};

			const hideDiagHover = (immediate) => {
				try {
					if (diagHoverShowTimer) {
						clearTimeout(diagHoverShowTimer);
						diagHoverShowTimer = null;
					}
					diagHoverPending = null;
					if (diagHoverHideTimer) {
						clearTimeout(diagHoverHideTimer);
						diagHoverHideTimer = null;
					}
					if (immediate) {
						if (diagHoverEl) diagHoverEl.style.display = 'none';
						return;
					}
					diagHoverHideTimer = setTimeout(() => {
						try {
							if (diagHoverEl) diagHoverEl.style.display = 'none';
						} catch { /* ignore */ }
					}, 50);
				} catch { /* ignore */ }
			};

			const getDiagnosticAt = (model, position) => {
				try {
					if (!model || !position) return null;
					const markers = monaco.editor.getModelMarkers({ owner: DIAG_OWNER, resource: model.uri });
					if (!markers || !markers.length) return null;
					const line = position.lineNumber;
					const col = position.column;
					for (const m of markers) {
						if (!m) continue;
						if (m.startLineNumber > line || m.endLineNumber < line) continue;
						if (m.startLineNumber === line && m.startColumn > col) continue;
						if (m.endLineNumber === line && m.endColumn < col) continue;
						return m;
					}
					return null;
				} catch {
					return null;
				}
			};

			const formatDiagMessageHtml = (msg) => {
				const raw = String(msg || '').trim();
				const esc = (typeof escapeHtml === 'function') ? escapeHtml(raw) : raw;
				// Minimal markdown-ish formatting: `code` + newlines.
				const withCode = String(esc)
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/\n/g, '<br/>');
				return (
					'<div style="font-weight:600; margin-bottom:6px;">Kusto syntax issue</div>' +
					'<div style="opacity:0.95;">' + withCode + '</div>'
				);
			};

			const isMonacoContextMenuVisible = () => {
				try {
					const dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
					if (!dom) return false;
					// Monaco renders quick-fix/lightbulb menus inside a context-view container.
					const menu = dom.querySelector('.context-view .monaco-menu-container');
					if (menu) {
						const r = menu.getBoundingClientRect();
						if ((r.width || 0) > 2 && (r.height || 0) > 2) return true;
					}
					return false;
				} catch {
					return false;
				}
			};

			const positionDiagHover = (el, clientX, clientY) => {
				try {
					const pad = 12;
					const maxW = 560;
					el.style.maxWidth = maxW + 'px';
					el.style.left = '0px';
					el.style.top = '0px';
					el.style.display = 'block';
					// Measure now that it's visible.
					const rect = el.getBoundingClientRect();
					const vw = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
					const vh = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
					let x = (Number(clientX) || 0) + pad;
					// Prefer above the pointer/caret.
					let y = (Number(clientY) || 0) - (rect.height || 0) - pad;
					if (y < 6) {
						y = (Number(clientY) || 0) + pad;
					}
					if (vw && rect.width && x + rect.width > vw - 6) {
						x = Math.max(6, vw - rect.width - 6);
					}
					if (vh && rect.height && y + rect.height > vh - 6) {
						// Clamp within viewport.
						y = Math.max(6, vh - rect.height - 6);
					}
					el.style.left = Math.round(x) + 'px';
					el.style.top = Math.round(y) + 'px';
				} catch { /* ignore */ }
			};

			const getClientPointForCursor = (pos) => {
				try {
					if (!pos) return null;
					const dom = editor && typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
					if (!dom) return null;
					const r = dom.getBoundingClientRect();
					const v = editor.getScrolledVisiblePosition(pos);
					if (!v) return null;
					// Place near the caret. +2 so it doesn't overlap the glyph.
					return {
						clientX: Math.round(r.left + (v.left || 0) + 2),
						clientY: Math.round(r.top + (v.top || 0) + 2)
					};
				} catch {
					return null;
				}
			};

			const showDiagHover = (marker, mouseEventOrPoint) => {
				try {
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					// Don't show our tooltip while Monaco is displaying a context menu (e.g. lightbulb quick fix).
					if (isMonacoContextMenuVisible()) {
						hideDiagHover(true);
						return;
					}
					const el = ensureDiagHoverEl();
					const key = String(marker.code || '') + '|' + String(marker.message || '') + '|' + marker.startLineNumber + ':' + marker.startColumn + '-' + marker.endLineNumber + ':' + marker.endColumn;
					if (key !== diagHoverLastKey) {
						diagHoverLastKey = key;
						el.innerHTML = formatDiagMessageHtml(marker.message || '');
					}
					el.style.display = 'block';
					const be = mouseEventOrPoint && mouseEventOrPoint.browserEvent ? mouseEventOrPoint.browserEvent : null;
					const cx = be ? be.clientX : (mouseEventOrPoint && typeof mouseEventOrPoint.clientX === 'number' ? mouseEventOrPoint.clientX : 0);
					const cy = be ? be.clientY : (mouseEventOrPoint && typeof mouseEventOrPoint.clientY === 'number' ? mouseEventOrPoint.clientY : 0);
					positionDiagHover(el, cx, cy);
				} catch { /* ignore */ }
			};

			const scheduleDiagHover = (marker, point, source) => {
				try {
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					// If a context menu is visible, never schedule.
					if (isMonacoContextMenuVisible()) {
						hideDiagHover(true);
						return;
					}
					const key = String(marker.code || '') + '|' + String(marker.message || '') + '|' + marker.startLineNumber + ':' + marker.startColumn + '-' + marker.endLineNumber + ':' + marker.endColumn;
					diagHoverPending = { key, marker, point, source, at: Date.now() };
					if (diagHoverShowTimer) {
						clearTimeout(diagHoverShowTimer);
						diagHoverShowTimer = null;
					}
					diagHoverShowTimer = setTimeout(() => {
						try {
							if (!diagHoverPending) return;
							// If a Monaco context menu is now visible, abort.
							if (isMonacoContextMenuVisible()) {
								hideDiagHover(true);
								return;
							}
							const pending = diagHoverPending;
							// Only show if the pending marker is still the most recent.
							if (!pending || !pending.marker) return;
							// Avoid showing stale tooltips if the user moved away.
							if (pending.source === 'mouse') {
								if (computeActiveSource() !== 'mouse') return;
								const model = editor.getModel();
								const pos = diagHoverLastMouse.position;
								if (!model || !pos) return;
								const current = getDiagnosticAt(model, pos);
								if (!current) return;
								const curKey = String(current.code || '') + '|' + String(current.message || '') + '|' + current.startLineNumber + ':' + current.startColumn + '-' + current.endLineNumber + ':' + current.endColumn;
								if (curKey !== pending.key) return;
								showDiagHover(current, pending.point);
								return;
							}
							// cursor
							try {
								if (!editor.hasTextFocus()) return;
							} catch { /* ignore */ }
							if (computeActiveSource() !== 'cursor') return;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos) return;
							const current = getDiagnosticAt(model, pos);
							if (!current) return;
							const curKey = String(current.code || '') + '|' + String(current.message || '') + '|' + current.startLineNumber + ':' + current.startColumn + '-' + current.endLineNumber + ':' + current.endColumn;
							if (curKey !== pending.key) return;
							showDiagHover(current, pending.point);
						} catch { /* ignore */ }
					}, DIAG_HOVER_SHOW_DELAY_MS);
				} catch { /* ignore */ }
			};

			const computeActiveSource = () => {
				const m = diagHoverLastMouse.at || 0;
				const c = diagHoverLastCursor.at || 0;
				return (m >= c) ? 'mouse' : 'cursor';
			};

			const refreshDiagHoverFromActiveSource = () => {
				try {
					const model = editor.getModel();
					if (!model) {
						hideDiagHover(false);
						return;
					}

					const source = computeActiveSource();
					diagHoverActiveSource = source;

					if (source === 'mouse') {
						const pos = diagHoverLastMouse.position;
						if (!pos) {
							hideDiagHover(false);
							return;
						}
						const marker = getDiagnosticAt(model, pos);
						if (!marker) {
							hideDiagHover(false);
							return;
						}
						scheduleDiagHover(marker, { clientX: diagHoverLastMouse.clientX, clientY: diagHoverLastMouse.clientY }, 'mouse');
						return;
					}

					// cursor
					// Only show cursor-driven tooltip when editor is focused.
					try {
						if (!editor.hasTextFocus()) {
							hideDiagHover(false);
							return;
						}
					} catch { /* ignore */ }
					const pos = editor.getPosition();
					if (!pos) {
						hideDiagHover(false);
						return;
					}
					const marker = getDiagnosticAt(model, pos);
					if (!marker) {
						hideDiagHover(false);
						return;
					}
					const pt = getClientPointForCursor(pos) || { clientX: 0, clientY: 0 };
					scheduleDiagHover(marker, pt, 'cursor');
				} catch {
					hideDiagHover(false);
				}
			};

			// Hook mouse move to show diagnostics on hover.
			try {
				editor.onMouseMove((e) => {
					try {
						const now = Date.now();
						diagHoverLastMouse.at = now;
						if (!e || !e.target) {
							hideDiagHover(false);
							return;
						}
						const pos = e.target.position;
						const model = editor.getModel();
						if (!pos || !model) {
							hideDiagHover(false);
							return;
						}
						// Only treat as mouse-driven when the mouse actually moved.
						try {
							const be = e && e.event && e.event.browserEvent ? e.event.browserEvent : null;
							if (be) {
								diagHoverLastMouse.clientX = be.clientX;
								diagHoverLastMouse.clientY = be.clientY;
							}
						} catch { /* ignore */ }
						diagHoverLastMouse.position = pos;
						const marker = getDiagnosticAt(model, pos);
						if (!marker) {
							// If mouse is the active source, hide; otherwise leave cursor tooltip alone.
							if (computeActiveSource() === 'mouse') {
								hideDiagHover(false);
							}
							return;
						}
						if (computeActiveSource() === 'mouse') {
							scheduleDiagHover(marker, { clientX: diagHoverLastMouse.clientX, clientY: diagHoverLastMouse.clientY }, 'mouse');
						}
					} catch {
						hideDiagHover(false);
					}
				});
			} catch { /* ignore */ }

			// Hook cursor moves (keyboard or programmatic) to show diagnostics at caret.
			try {
				editor.onDidChangeCursorPosition((e) => {
					try {
						diagHoverLastCursor.at = Date.now();
						diagHoverLastCursor.position = e && e.position ? e.position : null;
						refreshDiagHoverFromActiveSource();
					} catch {
						// ignore
					}
				});
			} catch { /* ignore */ }

			// If mouse is the active source, refresh when we scroll.
			try {
				editor.onDidScrollChange(() => {
					try {
						if (computeActiveSource() === 'cursor') {
							refreshDiagHoverFromActiveSource();
						}
					} catch { /* ignore */ }
				});
			} catch { /* ignore */ }

			try {
				editor.onMouseLeave(() => hideDiagHover(true));
			} catch { /* ignore */ }
			try {
				editor.onDidBlurEditorText(() => hideDiagHover(true));
			} catch { /* ignore */ }
		} catch {
			// ignore
		}

		// Active statement indicator (only when multi-statement via blank-line separators).
		// We intentionally avoid a background highlight; instead, we draw a subtle gutter bar.
		try {
			// Shared statement splitting helpers.
			// - A "blank line" is a line containing only whitespace.
			// - Statements are separated by one-or-more blank lines (the existing behavior).
			// This must match Run Query behavior and the gutter indicator.
			try {
				if (typeof window.__kustoStatementSeparatorMinBlankLines !== 'number') {
					window.__kustoStatementSeparatorMinBlankLines = 1;
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoGetStatementBlocksFromModel !== 'function') {
					window.__kustoGetStatementBlocksFromModel = function (model) {
						try {
							if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return [];
							const minBlankLines = Math.max(1, Number(window.__kustoStatementSeparatorMinBlankLines) || 1);
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							if (!lineCount) return [];
							const blocks = [];
							let startLine = null;
							let lastNonBlankLine = null;
							let blankRun = 0;
							for (let ln = 1; ln <= lineCount; ln++) {
								const lineText = String(model.getLineContent(ln) || '');
								const isBlank = /^\s*$/.test(lineText);
								if (!isBlank) {
									if (startLine === null) {
										startLine = ln;
									}
									lastNonBlankLine = ln;
									blankRun = 0;
									continue;
								}

								// Blank line.
								if (startLine === null) {
									// Leading blank lines before the first statement.
									continue;
								}
								blankRun++;
								if (blankRun >= minBlankLines) {
									// Statement separator: end the current block at the last non-blank line.
									if (lastNonBlankLine !== null && lastNonBlankLine >= startLine) {
										blocks.push({ startLine: startLine, endLine: lastNonBlankLine });
									}
									startLine = null;
									lastNonBlankLine = null;
									blankRun = minBlankLines;
								}
							}
							if (startLine !== null && lastNonBlankLine !== null) {
								blocks.push({ startLine: startLine, endLine: lastNonBlankLine });
							}
							return blocks;
						} catch {
							return [];
						}
					};
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoIsSeparatorBlankLine !== 'function') {
					window.__kustoIsSeparatorBlankLine = function (model, lineNumber) {
						try {
							if (!model || typeof model.getLineContent !== 'function' || typeof model.getLineCount !== 'function') return false;
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							const ln = Number(lineNumber) || 0;
							if (!ln || ln < 1 || ln > lineCount) return false;
							const minBlankLines = Math.max(1, Number(window.__kustoStatementSeparatorMinBlankLines) || 1);
							const isBlank = /^\s*$/.test(String(model.getLineContent(ln) || ''));
							if (!isBlank) return false;
							let start = ln;
							while (start > 1) {
								const prev = String(model.getLineContent(start - 1) || '');
								if (!/^\s*$/.test(prev)) break;
								start--;
							}
							let end = ln;
							while (end < lineCount) {
								const next = String(model.getLineContent(end + 1) || '');
								if (!/^\s*$/.test(next)) break;
								end++;
							}
							const len = (end - start) + 1;
							return len >= minBlankLines;
						} catch {
							return false;
						}
					};
				}
			} catch { /* ignore */ }
			try {
				if (typeof window.__kustoExtractStatementTextAtCursor !== 'function') {
					window.__kustoExtractStatementTextAtCursor = function (editor) {
						try {
							if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos || !pos.lineNumber) return null;
							const cursorLine = Number(pos.lineNumber) || 0;
							if (!cursorLine || cursorLine < 1) return null;
							// If the cursor is on a separator (2+ blank lines), treat as "no statement".
							try {
								if (window.__kustoIsSeparatorBlankLine && window.__kustoIsSeparatorBlankLine(model, cursorLine)) {
									return null;
								}
							} catch { /* ignore */ }
							const blocks = (window.__kustoGetStatementBlocksFromModel && typeof window.__kustoGetStatementBlocksFromModel === 'function')
								? window.__kustoGetStatementBlocksFromModel(model)
								: [];
							if (!blocks || !blocks.length) return null;
							let block = null;
							for (const b of blocks) {
								if (!b) continue;
								if (cursorLine >= b.startLine && cursorLine <= b.endLine) { block = b; break; }
							}
							if (!block) return null;
							const endCol = (typeof model.getLineMaxColumn === 'function') ? model.getLineMaxColumn(block.endLine) : 1;
							const range = {
								startLineNumber: block.startLine,
								startColumn: 1,
								endLineNumber: block.endLine,
								endColumn: endCol
							};
							const text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
							const trimmed = String(text || '').trim();
							return trimmed || null;
						} catch {
							return null;
						}
					};
				}
			} catch { /* ignore */ }

			const ACTIVE_STMT_CLASS = 'kusto-active-statement-gutter';
			let activeStmtDecorationIds = [];
			let cachedBlocks = null;
			let cachedVersionId = -1;
			let scheduled = false;

			const computeStatementBlocks = (model) => {
				try {
					if (window.__kustoGetStatementBlocksFromModel && typeof window.__kustoGetStatementBlocksFromModel === 'function') {
						return window.__kustoGetStatementBlocksFromModel(model);
					}
				} catch { /* ignore */ }
				return [];
			};

			const getBlocksCached = (model) => {
				try {
					const v = (model && typeof model.getVersionId === 'function') ? model.getVersionId() : -1;
					if (v !== cachedVersionId || !Array.isArray(cachedBlocks)) {
						cachedVersionId = v;
						cachedBlocks = computeStatementBlocks(model);
					}
					return Array.isArray(cachedBlocks) ? cachedBlocks : [];
				} catch {
					cachedVersionId = -1;
					cachedBlocks = null;
					return [];
				}
			};

			const updateActiveStatementIndicator = () => {
				scheduled = false;
				try {
					const model = editor.getModel && editor.getModel();
					const pos = editor.getPosition && editor.getPosition();
					if (!model || !pos || !pos.lineNumber) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}
					const blocks = getBlocksCached(model);
					// Only show when there are 2+ statements separated by blank lines.
					if (!blocks || blocks.length < 2) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}
					// If cursor is on a separator blank-line run (2+ blank lines), don't show an active statement.
					try {
						if (window.__kustoIsSeparatorBlankLine && window.__kustoIsSeparatorBlankLine(model, pos.lineNumber)) {
							activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
							return;
						}
					} catch { /* ignore */ }

					let block = null;
					for (const b of blocks) {
						if (!b) continue;
						if (b.startLine <= pos.lineNumber && pos.lineNumber <= b.endLine) {
							block = b;
							break;
						}
					}
					if (!block) {
						activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
						return;
					}

					const range = new monaco.Range(block.startLine, 1, block.endLine, 1);
					activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, [
						{
							range,
							options: {
								isWholeLine: true,
								linesDecorationsClassName: ACTIVE_STMT_CLASS
							}
						}
					]);
				} catch {
					try { activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []); } catch { /* ignore */ }
				}
			};

			const scheduleUpdate = () => {
				try {
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(updateActiveStatementIndicator);
				} catch {
					scheduled = false;
					try { setTimeout(updateActiveStatementIndicator, 0); } catch { /* ignore */ }
				}
			};

			try {
				editor.onDidChangeCursorPosition(() => scheduleUpdate());
			} catch { /* ignore */ }
			try {
				editor.onDidChangeModelContent(() => {
					cachedVersionId = -1;
					scheduleUpdate();
				});
			} catch { /* ignore */ }
			try { editor.onDidFocusEditorText(() => scheduleUpdate()); } catch { /* ignore */ }
			try { editor.onDidBlurEditorText(() => scheduleUpdate()); } catch { /* ignore */ }
			// Initial paint.
			scheduleUpdate();
		} catch {
			// ignore
		}

		// SEM0139 helper: auto-select term and open Find-with-selection.
		try {
			if (!window.__kustoAutoFindStateByBoxId || typeof window.__kustoAutoFindStateByBoxId !== 'object') {
				window.__kustoAutoFindStateByBoxId = {};
			}
			if (typeof window.__kustoAutoFindInQueryEditor !== 'function') {
				window.__kustoAutoFindInQueryEditor = async (boxId, term) => {
					const bid = String(boxId || '').trim();
					const t = String(term || '');
					if (!bid || !t) return false;
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
					if (!ed) return false;
					try {
						const state = window.__kustoAutoFindStateByBoxId[bid];
						if (state && state.term === t) {
							return true;
						}
					} catch { /* ignore */ }
					const model = (ed && typeof ed.getModel === 'function') ? ed.getModel() : null;
					if (!model || typeof model.findMatches !== 'function') return false;
					let match = null;
					let usedTerm = t;
					const tryFind = (needle) => {
						try {
							const s = String(needle || '');
							if (!s) return null;
							const matches = model.findMatches(s, true, false, false, null, true, 1);
							return (matches && matches.length) ? matches[0] : null;
						} catch { /* ignore */ }
						return null;
					};

					// Try exact first, then a few safe normalizations for bracket/dynamic access.
					const candidates = (() => {
						const list = [];
						const push = (s) => {
							try {
								const v = String(s || '');
								if (!v) return;
								if (v.length > 400) return;
								if (!list.includes(v)) list.push(v);
							} catch { /* ignore */ }
						};

						push(t);
						// obj.["prop"] -> obj["prop"]
						push(t.replace(/\.\s*\[/g, '['));
						// Swap quote styles inside brackets: ["x"] <-> ['x']
						push(t.replace(/\[\s*"([^\"]+)"\s*\]/g, "['$1']"));
						push(t.replace(/\[\s*'([^']+)'\s*\]/g, '["$1"]'));
						// Extract inner property token from bracket access and try searching just that.
						try {
							const m = t.match(/\[\s*(?:"([^\"]+)"|'([^']+)')\s*\]/);
							const prop = m ? String(m[1] || m[2] || '') : '';
							if (prop) {
								push(prop);
								push('"' + prop + '"');
								push("'" + prop + "'");
								// obj.["prop"] -> obj.prop
								push(t.replace(/\[\s*(?:"([^\"]+)"|'([^']+)')\s*\]/g, '.' + prop).replace(/\.\./g, '.'));
							}
						} catch { /* ignore */ }

						return list;
					})();

					for (const c of candidates) {
						const m = tryFind(c);
						if (m && m.range) {
							match = m;
							usedTerm = c;
							break;
						}
					}

					if (!match || !match.range) {
						return false;
					}
					try {
						ed.focus();
						ed.setSelection(match.range);
						if (typeof ed.revealRangeInCenter === 'function') {
							ed.revealRangeInCenter(match.range);
						}
					} catch { /* ignore */ }
					try {
						const action = ed.getAction && ed.getAction('actions.findWithSelection');
						if (action && typeof action.run === 'function') {
							await action.run();
						} else {
							// Best-effort fallback.
							ed.trigger('keyboard', 'actions.find', {});
						}
					} catch { /* ignore */ }
					try {
						window.__kustoAutoFindStateByBoxId[bid] = { term: usedTerm, ts: Date.now() };
					} catch { /* ignore */ }
					return true;
				};
			}
			if (typeof window.__kustoClearAutoFindInQueryEditor !== 'function') {
				window.__kustoClearAutoFindInQueryEditor = (boxId) => {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					let had = false;
					try { had = !!(window.__kustoAutoFindStateByBoxId && window.__kustoAutoFindStateByBoxId[bid]); } catch { had = false; }
					if (!had) return;
					try { delete window.__kustoAutoFindStateByBoxId[bid]; } catch { /* ignore */ }
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
					if (!ed) return;
					try {
						// Close find widget if it was opened by us.
						ed.trigger('keyboard', 'closeFindWidget', {});
					} catch { /* ignore */ }
					try {
						// Clear selection highlight.
						const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
						if (pos) {
							ed.setSelection({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column });
						}
					} catch { /* ignore */ }
				};
			}
		} catch {
			// ignore
		}

		// Right-click Cut/Copy in Monaco context menu uses Monaco actions (not DOM cut/copy events).
		// Override those actions to use our clipboard workaround when possible.
		try {
			const tryOverride = (actionId, isCut) => {
				try {
					const action = editor.getAction && editor.getAction(actionId);
					if (!action || typeof action.run !== 'function') {
						return;
					}
					const originalRun = action.run.bind(action);
					action.run = async () => {
						try {
							if (window && typeof window.__kustoCopyOrCutMonacoEditor === 'function') {
								const ok = await window.__kustoCopyOrCutMonacoEditor(editor, !!isCut);
								if (ok) {
									return;
								}
							}
						} catch {
							// ignore and fall back
						}
						try {
							return await originalRun();
						} catch {
							// ignore
						}
					};
				} catch {
					// ignore
				}
			};
			tryOverride('editor.action.clipboardCutAction', true);
			tryOverride('editor.action.clipboardCopyAction', false);
		} catch {
			// ignore
		}

		queryEditors[boxId] = editor;
		// Allow other scripts to reliably map editor -> boxId (used for global key handlers).
		try { editor.__kustoBoxId = boxId; } catch { /* ignore */ }
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
		// NOTE: Be conservative here; hiding too early can suppress real suggestions.
		const __kustoHideSuggestIfNoSuggestions = (ed, expectedModelVersionId) => {
			try {
				const __kustoSafeEditorTrigger = (editor, commandId) => {
					try {
						if (!editor || !commandId) return;
						const result = editor.trigger('keyboard', commandId, {});
						// Some Monaco commands return a Promise; avoid unhandled rejections.
						if (result && typeof result.then === 'function') {
							result.catch(() => { /* ignore */ });
						}
					} catch {
						// ignore
					}
				};

				try {
					if (typeof expectedModelVersionId === 'number') {
						const model = ed && ed.getModel && ed.getModel();
						const current = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
						// If the user typed or the model changed, don't auto-hide.
						if (typeof current === 'number' && current !== expectedModelVersionId) {
							return;
						}
					}
				} catch {
					// ignore
				}

				const widget = __kustoFindSuggestWidgetForEditor(ed, { requireVisible: true, maxDistancePx: 320 });
				if (!widget) return;
				// IMPORTANT:
				// Don't hide merely because rows haven't rendered yet.
				// Monaco can take a tick (or longer with async providers) to populate the list.
				const text = String(widget.textContent || '').toLowerCase();
				const hasNoSuggestionsText = text.includes('no suggestions');
				const hasRows = !!(widget.querySelector && widget.querySelector('.monaco-list-row'));
				const isVisible = __kustoIsElementVisibleForSuggest(widget);
				const hasProgress = !!(widget.querySelector && widget.querySelector('.monaco-progress-container'));
				const hasLoadingText = text.includes('loading');
				if (isVisible && hasNoSuggestionsText && !hasRows && !hasProgress && !hasLoadingText) {
					// Use the built-in internal command; don't call non-existent editor actions.
					__kustoSafeEditorTrigger(ed, 'hideSuggestWidget');
				}
			} catch {
				// ignore
			}
		};

		// Enhancement (best-effort): when the suggest widget opens and the caret is inside a word,
		// preselect the suggestion that exactly matches the current word (if present).
		// This is intentionally defensive: if Monaco DOM/structure differs, it does nothing.
		const __kustoPreselectExactWordInSuggestIfPresent = (ed, expectedModelVersionId, forcedWord) => {
			try {
				if (!ed) return;
				try {
					if (typeof expectedModelVersionId === 'number') {
						const model = ed.getModel && ed.getModel();
						const current = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
						if (typeof current === 'number' && current !== expectedModelVersionId) {
							return;
						}
					}
				} catch { /* ignore */ }

				let currentWord = '';
				if (typeof forcedWord === 'string' && forcedWord.trim()) {
					currentWord = forcedWord;
				} else {
					currentWord = __kustoGetWordNearCursor(ed);
				}
				if (!currentWord || !String(currentWord).trim()) return;
				const normalize = (s) => {
					try {
						let x = String(s || '').trim();
						// Strip common wrappers seen in Kusto identifiers.
						x = x.replace(/^(\[|\(|\{|"|')+/, '').replace(/(\]|\)|\}|"|')+$/, '');
						// For aria labels like "ColumnName, field" or "ColumnName: type" keep only the identifier.
						x = x.split(/[\s,\(:]/g).filter(Boolean)[0] || x;
						return String(x || '').trim();
					} catch {
						return String(s || '').trim();
					}
				};
				const target = normalize(currentWord);
				if (!target) return;
				const targetLower = target.toLowerCase();

				const widget = __kustoFindSuggestWidgetForEditor(ed, { requireVisible: true, maxDistancePx: 320 });
				if (!widget || typeof widget.querySelectorAll !== 'function') return;

				const tryFocusByInternalListModel = () => {
					// Monaco virtualizes list rows; when the suggest list is large/unfiltered the exact
					// matching item may not be present in the DOM yet. In that case, use internal list/tree
					// models to locate the item and focus it.
					try {
						if (typeof ed.getContribution !== 'function') return false;
						const ctrl = ed.getContribution('editor.contrib.suggestController');
						if (!ctrl) return false;

						const candidates = [];
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch { /* ignore */ }

						const tryGetList = (w0) => {
							try {
								const w = (w0 && w0.value) ? w0.value : w0;
								if (!w) return null;
								return w._list || w.list || w._tree || w.tree || null;
							} catch {
								return null;
							}
						};

						const getListLength = (list) => {
							try {
								if (!list) return 0;
								if (typeof list.length === 'number') return Math.max(0, Math.floor(list.length));
								if (typeof list.getLength === 'function') return Math.max(0, Math.floor(list.getLength()));
								const m = list._model || list.model;
								if (m) {
									if (typeof m.length === 'number') return Math.max(0, Math.floor(m.length));
									if (typeof m.size === 'number') return Math.max(0, Math.floor(m.size));
									if (typeof m.getLength === 'function') return Math.max(0, Math.floor(m.getLength()));
									if (typeof m.getSize === 'function') return Math.max(0, Math.floor(m.getSize()));
								}
							} catch { /* ignore */ }
							return 0;
						};

						const getElementAt = (list, idx) => {
							try {
								if (!list || !isFinite(idx)) return null;
								if (typeof list.element === 'function') return list.element(idx);
								if (typeof list.getElementAt === 'function') return list.getElementAt(idx);
								const m = list._model || list.model;
								if (m) {
									if (typeof m.get === 'function') return m.get(idx);
									if (typeof m.element === 'function') return m.element(idx);
									if (typeof m.getElementAt === 'function') return m.getElementAt(idx);
								}
							} catch { /* ignore */ }
							return null;
						};

						const getLabelFromElement = (el) => {
							try {
								if (!el) return '';
								// Try common shapes across Monaco builds.
								const direct = el.label || el.textLabel || el.insertText || el.filterText;
								if (typeof direct === 'string') return direct;
								const completion = el.completion || el.suggestion || el.item || el._item || el._completionItem;
								if (completion) {
									const l = completion.label || completion.textLabel || completion.insertText || completion.filterText;
									if (typeof l === 'string') return l;
									if (l && typeof l.label === 'string') return l.label;
								}
								// Some builds store label as an object.
								if (el.label && typeof el.label.label === 'string') return el.label.label;
							} catch { /* ignore */ }
							return '';
						};

						for (const w0 of candidates) {
							const list = tryGetList(w0);
							const len = getListLength(list);
							if (!list || !len) continue;
							// Bound work: suggest lists can be large when unfiltered.
							const limit = Math.min(len, 2500);
							for (let i = 0; i < limit; i++) {
								const el = getElementAt(list, i);
								let label = getLabelFromElement(el);
								label = normalize(label);
								if (!label) continue;
								if (String(label).toLowerCase() === targetLower) {
									try { if (typeof list.reveal === 'function') list.reveal(i); } catch { /* ignore */ }
									try { if (typeof list.setFocus === 'function') list.setFocus([i]); } catch { /* ignore */ }
									try { if (typeof list.setSelection === 'function') list.setSelection([]); } catch { /* ignore */ }
									return true;
								}
							}
						}
					} catch { /* ignore */ }
					return false;
				};

				// First attempt: DOM rows (fast when the list is already rendered/filtered).
				let matchRow = null;
				try {
					const rows = widget.querySelectorAll('.monaco-list-row');
					if (rows && rows.length) {
						for (const row of rows) {
							if (!row) continue;
							let label = '';
							try {
								const labelName = row.querySelector && row.querySelector('.label-name');
								if (labelName && typeof labelName.textContent === 'string') {
									label = labelName.textContent;
								}
							} catch { /* ignore */ }
							if (!label) {
								try {
									const aria = row.getAttribute ? row.getAttribute('aria-label') : '';
									label = String(aria || '');
								} catch { /* ignore */ }
							}
							label = normalize(label);
							if (!label) continue;
							if (String(label).toLowerCase() === targetLower) {
								matchRow = row;
								break;
							}
						}
					}
				} catch { /* ignore */ }

				// If the matching row isn't rendered yet, fall back to internal list model.
				if (!matchRow) {
					const did = tryFocusByInternalListModel();
					if (did) return true;
					return;
				}

				// Prefer focusing the Monaco list via internal APIs (more reliable than DOM hover).
				try {
					let idx = NaN;
					try {
						const s = (matchRow.getAttribute && matchRow.getAttribute('data-index')) || '';
						idx = parseInt(String(s || ''), 10);
					} catch { /* ignore */ }
					if (!isFinite(idx)) {
						try {
							const ds = matchRow.dataset && (matchRow.dataset.index || matchRow.dataset.row);
							idx = parseInt(String(ds || ''), 10);
						} catch { /* ignore */ }
					}

					if (isFinite(idx) && typeof ed.getContribution === 'function') {
						const ctrl = ed.getContribution('editor.contrib.suggestController');
						const candidates = [];
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch { /* ignore */ }
						for (const w0 of candidates) {
							const w1 = (w0 && w0.value) ? w0.value : w0;
							if (!w1) continue;
							const list = w1._list || w1.list || w1._tree || w1.tree;
							if (!list) continue;
							try { if (typeof list.reveal === 'function') list.reveal(idx); } catch { /* ignore */ }
							// Only change focus (highlight). Do NOT set selection; some Monaco builds treat
							// selection changes as an accept/commit signal.
								try { if (typeof list.setFocus === 'function') list.setFocus([idx]); } catch { /* ignore */ }
								return true;
						}
					}
				} catch {
					// ignore
				}

				// Fallback: try to focus/select without accepting via gentle hover.
				try {
					const rect = matchRow.getBoundingClientRect ? matchRow.getBoundingClientRect() : null;
					const clientX = rect ? Math.floor(rect.left + Math.min(12, Math.max(2, rect.width / 2))) : 1;
					const clientY = rect ? Math.floor(rect.top + Math.min(8, Math.max(2, rect.height / 2))) : 1;
					const evInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };
					try { matchRow.dispatchEvent(new MouseEvent('mouseover', evInit)); } catch { /* ignore */ }
					try { matchRow.dispatchEvent(new MouseEvent('mousemove', evInit)); } catch { /* ignore */ }
					try { matchRow.dispatchEvent(new MouseEvent('mouseenter', evInit)); } catch { /* ignore */ }
					return true;
				} catch {
					// ignore
				}
			} catch {
				// ignore
			}
			return false;
		};

		const __kustoTriggerAutocomplete = (ed) => {
			try {
				if (!ed) return;
				let shouldDeferTrigger = false;
				// Ensure the editor's layout info is up-to-date before Monaco decides
				// whether the suggest widget should render above or below the caret.
				try {
					ed.layout();
					// Layout changes can be async in VS Code webviews; defer the trigger by a frame
					// so Monaco computes widget placement from the updated dimensions.
					shouldDeferTrigger = true;
				} catch { /* ignore */ }
				// Monaco decides whether to render the suggest widget above vs below the caret
				// based on the *estimated* widget height and the available space below.
				// In our auto-resizing editors, later instances can end up with very little
				// slack below the last line, making Monaco flip the widget above the caret.
				// Pre-compute space below the caret and temporarily lower maxVisibleSuggestions
				// (and, if needed, expand the wrapper) so Monaco chooses the below-caret path.
				try {
					const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
					const cursor = (pos && typeof ed.getScrolledVisiblePosition === 'function')
						? ed.getScrolledVisiblePosition(pos)
						: null;
					const layout = (typeof ed.getLayoutInfo === 'function') ? ed.getLayoutInfo() : null;
					if (cursor && layout && typeof layout.height === 'number') {
						const pad = 8;
						let availableBelowPx = Math.floor((layout.height || 0) - (cursor.top || 0) - (cursor.height || 0) - pad);
						if (!isFinite(availableBelowPx)) availableBelowPx = 0;
						const MIN_BELOW_PX = 60;
						if (availableBelowPx < MIN_BELOW_PX) {
							const root = (typeof ed.getDomNode === 'function') ? ed.getDomNode() : null;
							const wrapper = (root && root.closest) ? root.closest('.query-editor-wrapper') : null;
							if (wrapper && typeof wrapper.getBoundingClientRect === 'function') {
								const rect = wrapper.getBoundingClientRect();
								const currentH = Math.max(0, Math.round(rect.height || 0));
								const need = Math.max(0, MIN_BELOW_PX - availableBelowPx);
								if (currentH > 0 && need > 0) {
									wrapper.style.height = (currentH + need) + 'px';
									try {
										ed.layout();
										shouldDeferTrigger = true;
									} catch { /* ignore */ }
									availableBelowPx += need;
								}
							}
						}

						// Estimate an appropriate max visible count from the available space.
						let rowHeightPx = 22;
						try {
							if (monaco && monaco.editor && monaco.editor.EditorOption && typeof ed.getOption === 'function') {
								const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
								if (typeof lh === 'number' && lh > 0) rowHeightPx = Math.floor(lh);
							}
						} catch { /* ignore */ }
						const overheadPx = 16;
						const usable = Math.max(0, availableBelowPx - overheadPx);
						const maxVisible = Math.max(1, Math.floor(usable / Math.max(1, rowHeightPx)));
						try {
							ed.updateOptions({ suggest: { maxVisibleSuggestions: maxVisible } });
							shouldDeferTrigger = true;
						} catch { /* ignore */ }
					}
				} catch { /* ignore */ }

				let versionId = null;
				try {
					const model = ed.getModel && ed.getModel();
					versionId = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
				} catch { /* ignore */ }
				// Record the trigger context so the suggest widget observer can preselect when rows arrive.
				try {
					ed.__kustoLastSuggestTriggerAt = Date.now();
					ed.__kustoLastSuggestTriggerModelVersionId = (typeof versionId === 'number') ? versionId : null;
				} catch { /* ignore */ }
				const triggerNow = () => {
					try {
						ed.trigger('keyboard', 'editor.action.triggerSuggest', {});
						try { if (typeof ed.__kustoScheduleSuggestClamp === 'function') ed.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
					} catch { /* ignore */ }
				};
				if (shouldDeferTrigger) {
					try {
						requestAnimationFrame(() => {
							try { ed.layout(); } catch { /* ignore */ }
							triggerNow();
						});
					} catch {
						setTimeout(() => {
							try { ed.layout(); } catch { /* ignore */ }
							triggerNow();
						}, 0);
					}
				} else {
					triggerNow();
				}
				// Let Monaco render and providers settle before we decide to hide.
				// Use longer delays and only hide if the model didn't change.
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed, versionId), 1200);
				setTimeout(() => __kustoHideSuggestIfNoSuggestions(ed, versionId), 2500);
				// Best-effort preselect is driven by the suggest widget visibility observer (one-shot per open).
			} catch {
				// ignore
			}
		};

		// Expose the preselect helper so the suggest widget sizing/visibility observer can call it.
		try {
			editor.__kustoPreselectExactWordInSuggestIfPresent = (forcedWord) => {
				try {
					// Cache the current target word (best-effort) so callers can avoid redundant focus changes.
					try {
						if (typeof forcedWord === 'string' && forcedWord.trim()) {
							editor.__kustoLastSuggestPreselectTargetLower = forcedWord.trim().toLowerCase();
						} else {
							const t = String(__kustoGetWordNearCursor(editor) || '').trim();
							if (t) {
								editor.__kustoLastSuggestPreselectTargetLower = t.toLowerCase();
							}
						}
					} catch { /* ignore */ }
					const model = editor.getModel && editor.getModel();
					const vid = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
					// Prefer the version at trigger time (prevents selecting after typing changes the context).
					const expected = (typeof editor.__kustoLastSuggestTriggerModelVersionId === 'number')
						? editor.__kustoLastSuggestTriggerModelVersionId
						: (typeof vid === 'number' ? vid : null);
					return __kustoPreselectExactWordInSuggestIfPresent(editor, expected, forcedWord);
				} catch {
					return false;
				}
			};
		} catch { /* ignore */ }

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

		const __kustoReplaceAllText = (ed, nextText, label) => {
			try {
				if (!ed) return;
				const model = ed.getModel && ed.getModel();
				if (!model) return;
				const current = model.getValue();
				if (current === nextText) return;
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch { /* ignore */ }
				const full = model.getFullModelRange ? model.getFullModelRange() : null;
				if (!full) {
					model.setValue(nextText);
					return;
				}
				ed.executeEdits(label || 'kusto-format', [{ range: full, text: nextText }]);
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch { /* ignore */ }
			} catch {
				// ignore
			}
		};

		// Expose query formatting helpers for toolbar buttons.
		try {
			if (typeof window.__kustoSingleLineQueryForBoxId !== 'function') {
				window.__kustoSingleLineQueryForBoxId = (id) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoToSingleLineKusto(v);
						__kustoReplaceAllText(ed, next, 'kusto-single-line');
					} catch {
						// ignore
					}
				};
			}
			if (typeof window.__kustoPrettifyQueryForBoxId !== 'function') {
				window.__kustoPrettifyQueryForBoxId = (id) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoPrettifyKustoTextWithSemicolonStatements(v);
						__kustoReplaceAllText(ed, next, 'kusto-prettify');
					} catch {
						// ignore
					}
				};
			}
			if (typeof window.__kustoPrettifyKustoText !== 'function') {
				window.__kustoPrettifyKustoText = (text) => {
					try {
						return __kustoPrettifyKustoTextWithSemicolonStatements(String(text ?? ''));
					} catch {
						return String(text ?? '');
					}
				};
			}
			if (typeof window.__kustoCopySingleLineQueryForBoxId !== 'function') {
				window.__kustoCopySingleLineQueryForBoxId = async (id) => {
					try {
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						let v = ed.getValue ? ed.getValue() : '';
						// Match Run Query / Export behavior: when the editor is active/focused, operate on the statement under the cursor.
						try {
							const isActiveEditor = (typeof activeQueryEditorBoxId !== 'undefined') && (activeQueryEditorBoxId === id);
							const hasTextFocus = !!(ed && typeof ed.hasTextFocus === 'function' && ed.hasTextFocus());
							if ((hasTextFocus || isActiveEditor) && typeof window.__kustoExtractStatementTextAtCursor === 'function') {
								const stmt = window.__kustoExtractStatementTextAtCursor(ed);
								if (stmt) {
									v = stmt;
								} else {
									try { vscode && vscode.postMessage && vscode.postMessage({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to copy that statement as a single line.' }); } catch { /* ignore */ }
									return;
								}
							}
						} catch { /* ignore */ }
						const single = __kustoToSingleLineKusto(v);

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(single);
								try { vscode && vscode.postMessage && vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch { /* ignore */ }
								return;
							}
						} catch {
							// fall through
						}

						// Fallback path.
						const ta = document.createElement('textarea');
						ta.value = single;
						ta.setAttribute('readonly', '');
						ta.style.position = 'fixed';
						ta.style.left = '-9999px';
						ta.style.top = '0';
						(document.body || document.documentElement).appendChild(ta);
						ta.focus();
						ta.select();
						const ok = document.execCommand('copy');
						try { ta.parentNode && ta.parentNode.removeChild(ta); } catch { /* ignore */ }
						if (!ok) {
							throw new Error('copy failed');
						}
						try { vscode && vscode.postMessage && vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch { /* ignore */ }
					} catch {
						try { alert('Failed to copy single-line query to clipboard.'); } catch { /* ignore */ }
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

		// Ctrl+Enter / Ctrl+Shift+Enter should execute the query (same as the Run button).
		// NOTE: We install this at the Monaco level so Monaco can't consume Ctrl+Shift+Enter before
		// our document-level capture handler runs.
		try {
			const __kustoRunThisQueryBox = () => {
				try {
					if (typeof executeQuery === 'function') {
						executeQuery(boxId);
						return;
					}
					if (window && typeof window.executeQuery === 'function') {
						window.executeQuery(boxId);
					}
				} catch {
					// ignore
				}
			};
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
		} catch {
			// ignore
		}

		// Docs tooltip: keep visible while typing, even when Monaco autocomplete is open.
		const renderDocMarkdownToHtml = (markdown) => {
			let raw = String(markdown || '');
			if (!raw.trim()) {
				return '';
			}
			// Presentation tweak: remove the blank line between the signature (first line)
			// and the documentation that follows.
			try {
				const normalized = String(raw).replace(/\r\n/g, '\n');
				const lines = normalized.split('\n');
				let firstNonEmpty = -1;
				for (let i = 0; i < lines.length; i++) {
					if (String(lines[i] || '').trim().length > 0) {
						firstNonEmpty = i;
						break;
					}
				}
				if (firstNonEmpty >= 0) {
					const after = firstNonEmpty + 1;
					if (after < lines.length && String(lines[after] || '').trim().length === 0) {
						lines.splice(after, 1);
						raw = lines.join('\n');
					}
				}
			} catch {
				// ignore
			}
			const escaped = typeof escapeHtml === 'function' ? escapeHtml(raw) : raw;
			const html = escaped
				.replace(/\r\n/g, '\n')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				// Show literal **...** markers while also bolding the content.
				.replace(/\*\*([^*]+)\*\*/g, '<strong>**$1**</strong>');

			// Use per-line block elements so CSS can add bottom spacing per line.
			try {
				const parts = String(html).split('\n');
				return parts
					.map((line) => {
						const s = String(line ?? '');
						return '<div class="qe-caret-docs-line">' + (s.trim() ? s : '&nbsp;') + '</div>';
					})
					.join('');
			} catch {
				return html;
			}
		};

		// Render caret docs as a banner at the top of the editor (less distracting than a tooltip).
		// Keep triggers/content logic the same; only change presentation.
		const createDocOverlay = () => {
			const banner = document.getElementById(boxId + '_caret_docs');
			const text = document.getElementById(boxId + '_caret_docs_text') || banner;
			let lastHtml = '';
			let lastDocsHtml = '';
			let lastKey = '';
			const watermarkTitle = 'Smart documentation';
			const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';

			// Persist last docs HTML across editor/overlay recreation (can happen if VS Code detaches the webview DOM).
			try {
				if (!window.__kustoCaretDocsLastHtmlByBoxId || typeof window.__kustoCaretDocsLastHtmlByBoxId !== 'object') {
					window.__kustoCaretDocsLastHtmlByBoxId = {};
				}
				const cached = window.__kustoCaretDocsLastHtmlByBoxId[boxId];
				if (typeof cached === 'string' && cached.trim()) {
					lastDocsHtml = cached;
					lastHtml = cached;
					// If caret-docs are enabled, paint the cached docs immediately so we don't flash watermark.
					try {
						if (typeof caretDocsEnabled === 'undefined' || caretDocsEnabled !== false) {
							if (banner) banner.style.display = 'flex';
							if (text) {
								if (text.classList) text.classList.remove('is-watermark');
								text.innerHTML = cached;
							}
						}
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }

			// In VS Code webviews, document.hasFocus() can be unreliable when the VS Code window
			// loses focus. Track focus explicitly from window-level events.
			try {
				if (typeof window.__kustoWebviewHasFocus !== 'boolean') {
					window.__kustoWebviewHasFocus = true;
				}
				if (!window.__kustoWebviewFocusListenersInstalled) {
					window.__kustoWebviewFocusListenersInstalled = true;
					try {
						window.addEventListener(
							'blur',
							() => {
								try { window.__kustoWebviewHasFocus = false; } catch { /* ignore */ }
								// After focus flips, refresh the active overlay once so it can freeze/restore docs.
								try {
									setTimeout(() => {
										try {
											if (typeof window.__kustoRefreshActiveCaretDocs === 'function') {
												window.__kustoRefreshActiveCaretDocs();
											}
										} catch { /* ignore */ }
									}, 0);
								} catch { /* ignore */ }
							},
							true
						);
					} catch { /* ignore */ }
					try { window.addEventListener('focus', () => { try { window.__kustoWebviewHasFocus = true; } catch { /* ignore */ } }, true); } catch { /* ignore */ }
					try {
						document.addEventListener('visibilitychange', () => {
							try {
								// When the tab becomes hidden, treat as unfocused.
								window.__kustoWebviewHasFocus = !document.hidden;
							} catch { /* ignore */ }
						}, true);
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }

			const isWebviewFocused = () => {
				try {
					if (typeof window.__kustoWebviewHasFocus === 'boolean') {
						return !!window.__kustoWebviewHasFocus;
					}
				} catch { /* ignore */ }
				try {
					return typeof document.hasFocus === 'function' ? !!document.hasFocus() : true;
				} catch {
					return true;
				}
			};

			const showWatermark = () => {
				// Never overwrite real docs while the overall VS Code/webview is unfocused.
				try {
					if (!isWebviewFocused() && (lastDocsHtml || lastHtml)) {
						return;
					}
				} catch { /* ignore */ }
				try {
					if (banner) {
						banner.style.display = 'flex';
					}
				} catch { /* ignore */ }
				try { updatePlaceholderPosition(); } catch { /* ignore */ }
				try {
					if (text) {
						text.innerHTML =
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' +
							watermarkTitle +
							'</div>' +
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' +
							watermarkBody +
							'</div>';
						if (text.classList) {
							text.classList.add('is-watermark');
						}
					}
				} catch { /* ignore */ }
				lastHtml = '';
				lastKey = 'watermark';
			};

			const hide = () => {
				try {
					if (banner) banner.style.display = 'none';
				} catch {
					// ignore
				}
				try { updatePlaceholderPosition(); } catch { /* ignore */ }
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

						// When the editor is not focused, freeze the banner content.
						// This avoids resetting to the watermark while focus is elsewhere.
						try {
							let hasFocus = false;
							try {
								// If the overall VS Code/webview is unfocused, freeze regardless of Monaco state.
								try {
									if (typeof window.__kustoWebviewHasFocus === 'boolean' && window.__kustoWebviewHasFocus === false) {
										hasFocus = false;
										throw new Error('webview not focused');
									}
								} catch {
									// continue to other checks
								}

								// If the VS Code window/webview isn't focused, freeze regardless of Monaco internals.
								try {
									if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
										hasFocus = false;
										throw new Error('document not focused');
									}
								} catch {
									// continue to other checks
								}

								const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
								const ae = (typeof document !== 'undefined') ? document.activeElement : null;
								if (dom && ae && typeof dom.contains === 'function') {
									hasFocus = dom.contains(ae);
								} else {
									hasFocus =
									(typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) ||
									(typeof editor.hasWidgetFocus === 'function' && editor.hasWidgetFocus());
								}
							} catch {
								hasFocus =
								(typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) ||
								(typeof editor.hasWidgetFocus === 'function' && editor.hasWidgetFocus());
							}
							// Apply document focus as a final gate (activeElement can be stale when app loses focus).
							try {
								if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
									hasFocus = false;
								}
							} catch { /* ignore */ }
							if (!hasFocus) {
								// If we've never rendered any docs yet, keep the watermark behavior.
								if (!lastDocsHtml && !lastHtml) {
									showWatermark();
									return;
								}
								// If we have prior docs, ensure they remain rendered.
								try {
									if (lastDocsHtml && text) {
										if (text.classList) text.classList.remove('is-watermark');
										text.innerHTML = lastDocsHtml;
									}
								} catch { /* ignore */ }
								try {
									if (banner) banner.style.display = 'flex';
								} catch { /* ignore */ }
								try { updatePlaceholderPosition(); } catch { /* ignore */ }
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
								// When another editor is active, keep the last content (if any) instead
								// of resetting to the watermark.
								if (!lastHtml) {
									showWatermark();
								} else {
									try { if (banner) banner.style.display = 'flex'; } catch { /* ignore */ }
									try { updatePlaceholderPosition(); } catch { /* ignore */ }
								}
								return;
						}
					} catch {
						// ignore
					}

					const model = editor.getModel();
					const pos = editor.getPosition();
					const sel = editor.getSelection();
							if (!model || !pos || !sel || !sel.isEmpty()) {
								// Don't lose the last docs due to transient blur/selection glitches.
								if (lastDocsHtml) {
									try {
										if (banner) banner.style.display = 'flex';
										if (text) {
											if (text.classList) text.classList.remove('is-watermark');
											text.innerHTML = lastDocsHtml;
										}
									} catch { /* ignore */ }
									try { updatePlaceholderPosition(); } catch { /* ignore */ }
									return;
								}
								showWatermark();
								return;
							}

					const getter = window.__kustoGetHoverInfoAt;
					if (typeof getter !== 'function') {
						showWatermark();
						return;
					}

					// Probe near the caret so we still show docs when the caret is on/near '(' or ')' or just after ')'.
					// Keep the caret position first so active-argument detection stays accurate.
					const probePositions = [pos];
					let originalOffset = null;
					try {
						originalOffset = model.getOffsetAt(pos);
					} catch {
						originalOffset = null;
					}
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
							if (info && info.markdown) {
								// For control commands, do NOT keep docs visible after the caret moves outside
								// the command/options region, even if probing hits ')' or nearby characters.
								try {
									if (
										info.__kustoKind === 'controlCommand' &&
										typeof info.__kustoStartOffset === 'number' &&
										typeof info.__kustoMaxOffset === 'number' &&
										typeof originalOffset === 'number'
									) {
										if (originalOffset < info.__kustoStartOffset || originalOffset > info.__kustoMaxOffset) {
											info = null;
											continue;
										}
									}
								} catch { /* ignore */ }
								break;
							}
						} catch {
							// ignore
						}
					}
					const html = info && info.markdown ? renderDocMarkdownToHtml(info.markdown) : '';
					if (!html) {
						showWatermark();
						return;
					}

					const key = `${pos.lineNumber}:${pos.column}:${html.slice(0, 120)}`;
							if (html !== lastHtml) {
						lastHtml = html;
								lastDocsHtml = html;
								try {
									if (window.__kustoCaretDocsLastHtmlByBoxId && typeof window.__kustoCaretDocsLastHtmlByBoxId === 'object') {
										window.__kustoCaretDocsLastHtmlByBoxId[boxId] = html;
									}
								} catch { /* ignore */ }
						try {
							if (text) {
								if (text.classList) {
									text.classList.remove('is-watermark');
								}
								text.innerHTML = html;
							}
						} catch {
							// ignore
						}
					}
					if (key !== lastKey) {
						lastKey = key;
					}

					try {
						if (banner) banner.style.display = 'flex';
					} catch {
						// ignore
					}
					try { updatePlaceholderPosition(); } catch { /* ignore */ }
				} catch {
					// ignore
				}
			};

			return { update, hide, showWatermark };
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
								try {
									// Allow other features (e.g., async doc fetch) to request a re-render of the active caret-docs banner.
									window.__kustoRefreshActiveCaretDocs = refreshActive;
								} catch { /* ignore */ }
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
						try {
							if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
								docOverlay.hide();
							} else if (docOverlay && typeof docOverlay.showWatermark === 'function') {
								docOverlay.showWatermark();
							}
						} catch { /* ignore */ }
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
			updatePlaceholderPosition();
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
			try {
				if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
					window.__kustoScheduleKustoDiagnostics(boxId, 250);
				}
			} catch { /* ignore */ }
			try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		});
		editor.onDidFocusEditorText(() => {
			activeQueryEditorBoxId = boxId;
			try { activeMonacoEditor = editor; } catch { /* ignore */ }
			try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
			syncPlaceholder();
			ensureSchemaForBox(boxId);
			scheduleDocUpdate();
			try {
				if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
					window.__kustoScheduleKustoDiagnostics(boxId, 0);
				}
			} catch { /* ignore */ }
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				activeQueryEditorBoxId = boxId;
				try { activeMonacoEditor = editor; } catch { /* ignore */ }
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
							try {
								if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
									docOverlay.hide();
								}
							} catch { /* ignore */ }
							if (activeQueryEditorBoxId === boxId) {
								activeQueryEditorBoxId = null;
							}
							syncPlaceholder();
							// Keep existing docs banner content visible while unfocused.
							// (The overlay's update loop also freezes while unfocused.)
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
				try { activeMonacoEditor = editor; } catch { /* ignore */ }
				try { editor.layout(); } catch { /* ignore */ }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
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
						// Allow embedded UI (e.g. Copilot Chat) to receive focus.
						if (e.target.closest('.kusto-copilot-chat') || e.target.closest('[data-kusto-no-editor-focus="true"]')) {
							return;
						}
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
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
			});
			ro.observe(wrapper);
			queryEditorResizeObservers[boxId] = ro;
		}

		// In multi-editor layouts (e.g. Copilot split panes), editors can be created while hidden.
		// Ensure we relayout when the wrapper becomes visible again so Monaco widgets position correctly.
		try {
			if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers && queryEditorVisibilityObservers[boxId]) {
				try { queryEditorVisibilityObservers[boxId].disconnect(); } catch { /* ignore */ }
				try { delete queryEditorVisibilityObservers[boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try {
			if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers && queryEditorVisibilityMutationObservers[boxId]) {
				try { queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch { /* ignore */ }
				try { delete queryEditorVisibilityMutationObservers[boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		const scheduleRelayoutSoon = () => {
			try {
				requestAnimationFrame(() => {
					try { editor.layout(); } catch { /* ignore */ }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
				});
			} catch {
				setTimeout(() => {
					try { editor.layout(); } catch { /* ignore */ }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
				}, 0);
			}
		};

		try {
			const observedEl = wrapper || container;
			if (observedEl && typeof IntersectionObserver !== 'undefined') {
				const io = new IntersectionObserver((entries) => {
					try {
						if (!entries || !entries.length) return;
						for (const e of entries) {
							if (e && e.isIntersecting) {
								scheduleRelayoutSoon();
								break;
							}
						}
					} catch { /* ignore */ }
				});
				io.observe(observedEl);
				try { if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers) queryEditorVisibilityObservers[boxId] = io; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		try {
			if (wrapper && typeof MutationObserver !== 'undefined') {
				const mo = new MutationObserver(() => {
					try {
						// Only relayout if the wrapper is measurable (visible).
						const h = wrapper.getBoundingClientRect ? Math.round(wrapper.getBoundingClientRect().height || 0) : 0;
						if (h > 0) {
							scheduleRelayoutSoon();
						}
					} catch { /* ignore */ }
				});
				mo.observe(wrapper, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
				try { if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers) queryEditorVisibilityMutationObservers[boxId] = mo; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Drag handle resize (more reliable than CSS resize in VS Code webviews).
		if (resizer) {
			const resolveWrapperForResize = () => {
				try {
					let w = null;
					try {
						w = (resizer && resizer.closest) ? resizer.closest('.query-editor-wrapper') : null;
					} catch { /* ignore */ }
					if (!w) {
						try {
							w = (container && container.closest) ? container.closest('.query-editor-wrapper') : null;
						} catch { /* ignore */ }
					}
					if (!w) {
						try {
							const box = document.getElementById(boxId);
							w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
						} catch { /* ignore */ }
					}
					return w;
				} catch {
					return null;
				}
			};

			resizer.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();

				const w = resolveWrapperForResize();
				if (!w) {
					return;
				}
				try {
					w.dataset.kustoUserResized = 'true';
					try { delete w.dataset.kustoAutoResized; } catch { /* ignore */ }
				} catch { /* ignore */ }
				try {
					if (!window.__kustoManualQueryEditorHeightPxByBoxId || typeof window.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
						window.__kustoManualQueryEditorHeightPxByBoxId = {};
					}
				} catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = w.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
					w.style.height = nextHeight + 'px';
					try {
						if (window.__kustoManualQueryEditorHeightPxByBoxId && typeof window.__kustoManualQueryEditorHeightPxByBoxId === 'object') {
							window.__kustoManualQueryEditorHeightPxByBoxId[boxId] = Math.round(nextHeight);
						}
					} catch { /* ignore */ }
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
