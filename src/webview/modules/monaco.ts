// Monaco module — converted from legacy/monaco.js
// Monaco Editor configuration, completions, column inference, caret docs overlay.
// Window bridge exports at bottom for remaining legacy callers.
export {};

// Sub-modules (Phase 6 decomposition) — import ensures esbuild includes them in bundle.
import {
	__kustoToSingleLineKusto,
	__kustoExplodePipesToLines,
	__kustoSplitTopLevel,
	__kustoFindTopLevelKeyword,
	__kustoPrettifyWhereClause,
	__kustoPrettifyKusto,
	__kustoSplitKustoStatementsBySemicolon,
	__kustoPrettifyKustoTextWithSemicolonStatements,
} from './monaco-prettify';
import {
	isDarkTheme,
	getVSCodeEditorBackground,
	defineCustomThemes,
	applyMonacoTheme,
	startMonacoThemeObserver,
} from './monaco-theme';
import {
	__kustoNormalizeTextareasWritable,
	__kustoForceEditorWritable,
	__kustoInstallWritableGuard,
	__kustoEnsureEditorWritableSoon,
	__kustoEnsureAllEditorsWritableSoon,
} from './monaco-writable';
import {
	__kustoIsElementVisibleForSuggest,
	__kustoGetWordNearCursor,
	__kustoFindSuggestWidgetForEditor,
	__kustoRegisterGlobalSuggestMutationHandler,
	__kustoInstallSmartSuggestWidgetSizing,
} from './monaco-suggest';
import { __kustoAttachAutoResizeToContent } from './monaco-resize';

const _win = window;

// AMD globals loaded by require() — not available at module scope
// but referenced inside the require() callback and other functions.
declare const monaco: any;
declare const require: any;

// Derive `columnsByTable` from `columnTypesByTable` to avoid storing duplicate column lists.
// Falls back to legacy `columnsByTable` if present (older cached schema entries).
const __kustoColumnsByTableCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
function __kustoGetColumnsByTable(schema: any) {
	try {
		if (!schema || typeof schema !== 'object') return null;
		if (schema.columnsByTable && typeof schema.columnsByTable === 'object') return schema.columnsByTable;
		const types = schema.columnTypesByTable;
		if (!types || typeof types !== 'object') return null;
		if (__kustoColumnsByTableCache) {
			const cached = __kustoColumnsByTableCache.get(schema);
			if (cached) return cached;
		}
		const out: any = {};
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

function ensureMonaco() {
	if (_win.monacoReadyPromise) {
		return _win.monacoReadyPromise;
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
				} catch (e) { console.error('[kusto]', e); }
				if (attempts >= 60) {
					reject(new Error('Monaco AMD loader (require.js) not available in webview.'));
					return;
				}
				setTimeout(tick, 50);
			};
			tick();
		});
	};

	_win.monacoReadyPromise = new Promise((resolve, reject) => {
		try {
			waitForAmdLoader().then((req) => {
				// Monaco worker bootstrap.
				// Monaco 0.5x uses version-hashed worker assets under vs/assets. The extension host
				// discovers them and passes them into __kustoQueryEditorConfig.monacoWorkers.
				try {
					const cfg = window && _win.__kustoQueryEditorConfig ? _win.__kustoQueryEditorConfig : {};
					const workers = cfg && cfg.monacoWorkers ? cfg.monacoWorkers : null;
					const cacheBuster = cfg && cfg.cacheBuster ? String(cfg.cacheBuster) : '';

					const withCache = (url: any) => {
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
						_win.MonacoEnvironment = _win.MonacoEnvironment || {};
						
						// Use getWorker (returns Worker instance) instead of getWorkerUrl
						// This gives us more control over worker creation
						_win.MonacoEnvironment.getWorker = function (_workerId: any, label: any) {
							const l = String(label || '').toLowerCase();
							
							// For kusto, use the pre-bundled kusto worker that includes all dependencies
							if (l === 'kusto') {
								const kustoWorkerUrl = workers['kusto'];
								if (kustoWorkerUrl) {
									// VS Code webviews block direct Worker creation from vscode-resource URLs
									// We must use a blob worker that fetches the script content via XHR
									// then evals it (importScripts also doesn't work from blob workers to vscode-resource)
									const blobSource = [
										'// Kusto Worker Loader',
										'(function() {',
										'  var url = ' + JSON.stringify(kustoWorkerUrl) + ';',
										'  var xhr = new XMLHttpRequest();',
										'  xhr.open("GET", url, false);', // synchronous
										'  xhr.send(null);',
										'  if (xhr.status === 200) {',
										'    eval(xhr.responseText);',
										'  } else {',
										'    throw new Error("Failed to load kusto worker: " + xhr.status);',
										'  }',
										'})();'
									].join('\n');
									const blob = new Blob([blobSource], { type: 'application/javascript' });
									const blobUrl = URL.createObjectURL(blob);
									const worker = new Worker(blobUrl);
									setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) { console.error('[kusto]', e); } }, 30000);
									return worker;
								}
								// Fall back to standard editor worker if kusto worker not available
								return new Worker(cfg.monacoEditorWorkerUri || '');
							}
							
							// For other workers, create them directly
							let key = 'editor';
							if (l === 'json') key = 'json';
							else if (l === 'css' || l === 'scss' || l === 'less') key = 'css';
							else if (l === 'html' || l === 'handlebars' || l === 'razor') key = 'html';
							else if (l === 'typescript' || l === 'javascript') key = 'ts';

							const url = workers[key] || workers.editor;
							if (!url) {
								throw new Error('Monaco worker asset URL not available for label: ' + label);
							}
							
							// For vscode-resource URLs, we need to create a blob worker
							const workerUrl = withCache(url);
							try {
								return new Worker(workerUrl);
							} catch {
								// Fall back to blob worker
								const blobSource = 'importScripts(' + JSON.stringify(workerUrl) + ');';
								const blob = new Blob([blobSource], { type: 'application/javascript' });
								const blobUrl = URL.createObjectURL(blob);
								const worker = new Worker(blobUrl);
								setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) { console.error('[kusto]', e); } }, 30000);
								return worker;
							}
						};
					}
				} catch (e) { console.error('[kusto]', e); }

				try {
					(req as any).config({ paths: { vs: _win.__kustoQueryEditorConfig!.monacoVsUri } });
				} catch (e) {
					reject(e);
					return;
				}

				// Load Monaco editor first, then monaco-kusto contribution module
				// (monaco-kusto depends on Monaco's Emitter and other core classes being available)
				// NOTE: monaco-kusto requires 'vs/editor/editor.main' - not the hashed API file
				(req as any)(
					['vs/editor/editor.main'],
					() => {
						try {
							if (typeof monaco === 'undefined' || !monaco || !monaco.editor) {
								throw new Error('Monaco loaded but global `monaco` API is missing.');
							}

							// ========================================================================
							// LAZY DIAGNOSTICS: Intercept setModelMarkers to suppress red squiggles
							// until the user focuses a query box and schema is loaded.
							// This prevents "phantom" errors appearing before we have schema context.
							// Also suppresses markers for models whose cluster doesn't match current context.
							// ========================================================================
							try {
								const originalSetModelMarkers = monaco.editor.setModelMarkers;
								
								// Track which model URIs should have kusto markers enabled
								_win.__kustoMarkersEnabledModels = new Set();
								
								// Track model URI -> normalized cluster URL mapping
								// This allows us to suppress markers for models that don't match the current context
								_win.__kustoModelClusterMap = {};
								
								monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any) {
									// Only intercept kusto markers
									if (owner === 'kusto') {
										const uri = model && model.uri ? model.uri.toString() : '';
										if (!_win.__kustoMarkersEnabledModels.has(uri)) {
											// Suppress markers for models that haven't been focused yet
											return;
										}
										// CRITICAL: Suppress markers for models whose cluster doesn't match current context
										// monaco-kusto validates ALL models when schema changes, but we only want errors
										// for models that match the current schema context
										const modelCluster = _win.__kustoModelClusterMap[uri];
										const currentCluster = _win.__kustoMonacoDatabaseInContext?.clusterUrl;
										if (modelCluster && currentCluster) {
											const normalizeUrl = (url: any) => url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase() : '';
											const modelClusterNorm = normalizeUrl(modelCluster);
											const currentClusterNorm = normalizeUrl(currentCluster);
											if (modelClusterNorm !== currentClusterNorm) {
												// This model belongs to a different cluster - suppress markers
												return;
											}
										}
									}
									return originalSetModelMarkers.call(this, model, owner, markers);
								};
								
								// Function to enable markers for a specific model (called on focus AFTER schema context is set)
								_win.__kustoEnableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									if (!_win.__kustoMarkersEnabledModels.has(uri)) {
										_win.__kustoMarkersEnabledModels.add(uri);
									}
								};
								
								// Function to disable markers for a specific model (called on blur)
								// This removes the model from the enabled set and clears existing markers
								_win.__kustoDisableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									_win.__kustoMarkersEnabledModels.delete(uri);
									// Also clear any existing markers for this model
									try {
										const model = monaco.editor.getModels().find((m: any) => m.uri && m.uri.toString() === uri);
										if (model) {
											originalSetModelMarkers.call(monaco.editor, model, 'kusto', []);
										}
									} catch (e) { console.error('[kusto]', e); }
								};
							} catch (e) { console.error('[kusto]', e); }

							// Now load monaco-kusto after Monaco is fully initialized
							(req as any)(['vs/language/kusto/monaco.contribution'], () => {
								try {
					// monaco.languages.register({ id: 'kusto' });

					const KUSTO_KEYWORD_DOCS: Record<string, any> = {
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

					const KUSTO_FUNCTION_DOCS: Record<string, any> = {
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

					const isIdentChar = (ch: any) => /[A-Za-z0-9_\-]/.test(ch);
					const isIdentStart = (ch: any) => /[A-Za-z_]/.test(ch);

					// Merge generated function docs (from `queryEditor/functions.generated.js`) into our in-memory
					// `KUSTO_FUNCTION_DOCS` table. Smart Docs (hover/caret-docs panel) and autocomplete both rely on
					// `KUSTO_FUNCTION_DOCS`, so this must run even if the user never triggers completion.
					const __kustoEnsureGeneratedFunctionsMerged = () => {
						try {
							if (typeof window === 'undefined' || !window) return;
							if (_win.__kustoGeneratedFunctionsMerged) return;
							_win.__kustoGeneratedFunctionsMerged = true;

							const raw = Array.isArray(_win.__kustoFunctionEntries) ? _win.__kustoFunctionEntries : [];
							const docs = (_win.__kustoFunctionDocs && typeof _win.__kustoFunctionDocs === 'object') ? _win.__kustoFunctionDocs : null;
							for (const ent of raw) {
								const name = Array.isArray(ent) ? ent[0] : (ent && ent.name);
								if (!name) continue;
								const fnRaw = String(name).trim();
								if (!fnRaw) continue;
								if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnRaw)) continue;
								const fnKey = fnRaw.toLowerCase();
								if (KUSTO_FUNCTION_DOCS[fnKey]) continue;

								const g = (docs && typeof docs === 'object')
									? ((docs[fnRaw] && typeof docs[fnRaw] === 'object') ? docs[fnRaw] : (docs[fnKey] && typeof docs[fnKey] === 'object') ? docs[fnKey] : null)
									: null;
								let args = [];
								let description = 'Kusto function.';
								let signature = undefined;
								let docUrl = undefined;
								try {
									if (g) {
										if (Array.isArray(g.args)) args = g.args;
										if (g.description) description = String(g.description);
										if (g.signature) signature = String(g.signature);
										if (g.docUrl) docUrl = String(g.docUrl);
									}
								} catch (e) { console.error('[kusto]', e); }

								KUSTO_FUNCTION_DOCS[fnKey] = {
									args,
									returnType: 'scalar',
									description,
									signature,
									docUrl
								};
							}
						} catch (e) { console.error('[kusto]', e); }
					};

					// --- Kusto control/management commands (dot-prefixed) ---
					// Data is provided by `media/queryEditor/controlCommands.generated.js`.
					const KUSTO_CONTROL_COMMAND_DOCS_BASE_URL = 'https://learn.microsoft.com/en-us/kusto/';
					const KUSTO_CONTROL_COMMAND_DOCS_VIEW = 'azure-data-explorer';
					const KUSTO_CONTROL_COMMAND_DOCS_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

					const __kustoNormalizeControlCommand = (s: any) => {
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
						const raw = (typeof window !== 'undefined' && Array.isArray(_win.__kustoControlCommandEntries))
							? _win.__kustoControlCommandEntries
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
							if (!_win.__kustoControlCommandDocCache || typeof _win.__kustoControlCommandDocCache !== 'object') {
								_win.__kustoControlCommandDocCache = {};
							}
							if (!_win.__kustoControlCommandDocPending || typeof _win.__kustoControlCommandDocPending !== 'object') {
								_win.__kustoControlCommandDocPending = {};
							}
							return _win.__kustoControlCommandDocCache;
						} catch {
							return {};
						}
					};

					const __kustoParseControlCommandSyntaxFromLearnHtml = (html: any) => {
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

						const cleanCode = (code: any) => {
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
							} catch (e) { console.error('[kusto]', e); }
						}

						// Regex fallback if DOMParser isn't available.
						try {
							const m = s.match(/<h2[^>]*>\s*Syntax\s*<\/h2>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/i);
							if (m && m[1]) {
								const inner = String(m[1]).replace(/<[^>]+>/g, '');
								const txt = cleanCode(inner);
								if (txt) return txt;
							}
						} catch (e) { console.error('[kusto]', e); }

						return null;
					} catch {
						return null;
					}
					};

					const __kustoExtractWithOptionArgsFromSyntax = (syntaxText: any) => {
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

					const __kustoScheduleFetchControlCommandSyntax = (cmd: any) => {
						try {
							if (!cmd || !cmd.commandLower || !cmd.href) return;
							const cache = __kustoGetOrInitControlCommandDocCache();
							const key = String(cmd.commandLower);
							const entry = cache[key];
							const now = Date.now();
							if (entry && entry.fetchedAt && (now - entry.fetchedAt) < KUSTO_CONTROL_COMMAND_DOCS_CACHE_TTL_MS && entry.syntax) {
								return;
							}
							if (_win.__kustoControlCommandDocPending && _win.__kustoControlCommandDocPending[key]) return;
							const requestId = `ccs_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
							_win.__kustoControlCommandDocPending[key] = requestId;
							try {
								if (typeof _win.vscode !== 'undefined' && _win.vscode && typeof _win.vscode.postMessage === 'function') {
									_win.vscode.postMessage({
										type: 'fetchControlCommandSyntax',
										requestId,
										commandLower: key,
										href: String(cmd.href)
									});
								}
							} catch (e) { console.error('[kusto]', e); }
						} catch (e) { console.error('[kusto]', e); }
					};

					const __kustoFindEnclosingWithOptionsParen = (model: any, statementStartOffset: any, cursorOffset: any) => {
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

					const __kustoFindWithOptionsParenRange = (text: any, statementStartOffset: any) => {
						try {
							const full = String(text || '');
							const start = Math.max(0, Number(statementStartOffset) || 0);
							const slice = full.slice(start, Math.min(full.length, start + 4000));
							if (!slice) return null;

							let inLineComment = false;
							let inBlockComment = false;
							let inSingle = false;
							let inDouble = false;

							const isIdentPart = (ch: any) => /[A-Za-z0-9_\-]/.test(ch);
							const eqIgnoreCaseAt = (i: any, word: any) => slice.substr(i, word.length).toLowerCase() === word;

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

					const __kustoGetControlCommandHoverAt = (model: any, position: any) => {
						try {
							if (!__kustoControlCommands || __kustoControlCommands.length === 0) return null;
							const full = model.getValue();
							if (!full) return null;
							const offset = model.getOffsetAt(position);
							const statementStart = _win.__kustoGetStatementStartAtOffset(full, offset);
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
							try { __kustoScheduleFetchControlCommandSyntax(best); } catch (e) { console.error('[kusto]', e); }
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
										.map((a: any, i: any) => (i === active ? `**${a}**=` : `${a}=`))
										.join(', ');
									signature = `${best.command} with (${formatted}...)`;
								}
							} catch (e) { console.error('[kusto]', e); }

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
							} catch (e) { console.error('[kusto]', e); }
							return { range, markdown, __kustoKind: 'controlCommand', __kustoStartOffset: commandStartOffset, __kustoMaxOffset: maxOffset };
						} catch {
							return null;
						}
					};

					const getTokenAtPosition = (model: any, position: any) => {
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

					const getMultiWordOperatorAt = (model: any, position: any) => {
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

					const getWordRangeAt = (model: any, position: any) => {
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

					const findEnclosingFunctionCall = (model: any, offset: any) => {
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

					const computeArgIndex = (model: any, openParenOffset: any, offset: any) => {
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

					const buildFunctionSignatureMarkdown = (name: any, doc: any, activeArgIndex: any) => {
						const args = Array.isArray(doc.args) ? doc.args : [];
						const formattedArgs = args.map((a: any, i: any) => (i === activeArgIndex ? `**${a}**` : a)).join(', ');
						const ret = doc.returnType ? `: ${doc.returnType}` : '';
						return `\`${name}(${formattedArgs})${ret}\``;
					};

					const getHoverInfoAt = (model: any, position: any) => {
						try { __kustoEnsureGeneratedFunctionsMerged(); } catch (e) { console.error('[kusto]', e); }
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
								} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
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
								} catch (e) { console.error('[kusto]', e); }
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
					const formatKusto = (input: any) => {
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
						provideDocumentFormattingEdits(model: any) {
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

								// Use custom themes that match VS Code's editor background
								applyMonacoTheme(monaco);
					// Autocomplete: pipe operators + (optionally) schema tables/columns.
					// Keep a reference to our completion provider so diagnostics can be filtered
					// using the exact same suggestion logic ("if it's in autocomplete, it must not squiggle").
					// Completion provider and diagnostics extracted to monaco-completions.ts / monaco-diagnostics.ts.
					// Inject dependencies from this AMD callback scope into the completion provider module.
					if (typeof _win.__kustoInitCompletionDeps === 'function') {
						_win.__kustoInitCompletionDeps({
							KUSTO_FUNCTION_DOCS,
							KUSTO_KEYWORD_DOCS,
							KUSTO_CONTROL_COMMAND_DOCS_BASE_URL,
							KUSTO_CONTROL_COMMAND_DOCS_VIEW,
							__kustoControlCommands,
							findEnclosingFunctionCall,
							getTokenAtPosition,
							__kustoGetStatementStartAtOffset: _win.__kustoGetStatementStartAtOffset,
							__kustoScanIdentifiers: _win.__kustoScanIdentifiers,
							__kustoSplitTopLevelStatements: _win.__kustoSplitTopLevelStatements,
							__kustoSplitPipelineStagesDeep: _win.__kustoSplitPipelineStagesDeep,
							__kustoGetColumnsByTable: _win.__kustoGetColumnsByTable,
						});
					}


					// Hover provider for diagnostics (shown on red underline hover).
					monaco.languages.registerHoverProvider('kusto', {
						provideHover: function (model: any, position: any) {
							try {
								const markers = monaco.editor.getModelMarkers({ owner: 'kusto-diagnostics', resource: model.uri });
								if (!markers || !markers.length) return null;
								const line = position.lineNumber;
								const col = position.column;
								const hit = markers.filter((m: any) =>
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
						provideHover: function (model: any, position: any) {
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
					_win.__kustoGetHoverInfoAt = getHoverInfoAt;

					// --- monaco-kusto integration ---
					// Track which schemas have been loaded into the monaco-kusto worker
					// Key: "clusterUrl|database" -> true
					// This is separate from our UI schema cache - this tracks what's IN the worker
					// IMPORTANT: monaco-kusto keeps schema state per Monaco model URI (workerAccessor(modelUri)).
					// If we always target models[0], schema/context updates apply to the wrong query box.
					_win.__kustoMonacoLoadedSchemas = _win.__kustoMonacoLoadedSchemas || {}; // legacy/global (kept for logs)
					_win.__kustoMonacoLoadedSchemasByModel = _win.__kustoMonacoLoadedSchemasByModel || {};
					_win.__kustoMonacoInitialized = false; // legacy/global (kept for logs)
					_win.__kustoMonacoInitializedByModel = _win.__kustoMonacoInitializedByModel || {};
					// Track the current database in context: { clusterUrl, database }
					_win.__kustoMonacoDatabaseInContext = null; // legacy/global (current focused model)
					_win.__kustoMonacoDatabaseInContextByModel = _win.__kustoMonacoDatabaseInContextByModel || {};
					
					// Cache all raw schema data we receive, so we can re-add them after cluster switches
					// Key: `${clusterUrl}|${database}`, Value: { rawSchemaJson, clusterUrl, database }
					_win.__kustoSchemaCache = {};
					
					// Mutex to serialize schema operations - prevents race conditions during parallel loads
					_win.__kustoSchemaOperationQueue = Promise.resolve();
					
					// Function to set/add schema in monaco-kusto worker for full IntelliSense support
					// Uses aggregate approach: first schema uses setSchemaFromShowSchema, 
					// subsequent schemas use addDatabaseToSchema to ADD without replacing
					_win.__kustoSetMonacoKustoSchema = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
						// Serialize schema operations to prevent race conditions
						const operationPromise = _win.__kustoSchemaOperationQueue.then(async () => {
							return await _win.__kustoSetMonacoKustoSchemaInternal(rawSchemaJson, clusterUrl, database, setAsContext, modelUri, forceRefresh);
						}).catch((e: any) => {
							console.error('[monaco-kusto] Queued operation failed:', e);
						});
						_win.__kustoSchemaOperationQueue = operationPromise;
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
					_win.__kustoSetMonacoKustoSchemaInternal = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
						// Resolve which Monaco model this operation applies to
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						if (!models || models.length === 0) {
							return;
						}
						// IMPORTANT: schema/context caches are keyed by model URI. Monaco can reuse in-memory
						// URIs (e.g. inmemory://model/1) across file/session loads once models are disposed.
						// If we don't clean up per-model caches on dispose, a newly-created model can inherit
						// stale loadedSchemas/context and autocomplete will be wrong immediately.
						try {
							_win.__kustoMonacoModelDisposeHookInstalled = _win.__kustoMonacoModelDisposeHookInstalled || false;
							if (!_win.__kustoMonacoModelDisposeHookInstalled && monaco?.editor?.onWillDisposeModel) {
								_win.__kustoMonacoModelDisposeHookInstalled = true;
								monaco.editor.onWillDisposeModel((model: any) => {
									try {
										const uriKey = model?.uri ? model.uri.toString() : null;
										if (!uriKey) return;
										if (_win.__kustoMonacoLoadedSchemasByModel && _win.__kustoMonacoLoadedSchemasByModel[uriKey]) {
											try { delete _win.__kustoMonacoLoadedSchemasByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										}
										if (_win.__kustoMonacoDatabaseInContextByModel && _win.__kustoMonacoDatabaseInContextByModel[uriKey]) {
											try { delete _win.__kustoMonacoDatabaseInContextByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										}
										if (_win.__kustoMonacoInitializedByModel && _win.__kustoMonacoInitializedByModel[uriKey]) {
											try { delete _win.__kustoMonacoInitializedByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										}
										if (_win.__kustoModelClusterMap && _win.__kustoModelClusterMap[uriKey]) {
											try { delete _win.__kustoModelClusterMap[uriKey]; } catch (e) { console.error('[kusto]', e); }
										}
									} catch (e) { console.error('[kusto]', e); }
								});
							}
						} catch (e) { console.error('[kusto]', e); }

						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : modelUri.toString()) : models[0].uri.toString();
						_win.__kustoMonacoLoadedSchemasByModel[modelKey] = _win.__kustoMonacoLoadedSchemasByModel[modelKey] || {};
						_win.__kustoMonacoDatabaseInContextByModel[modelKey] = _win.__kustoMonacoDatabaseInContextByModel[modelKey] || null;
						_win.__kustoMonacoInitializedByModel[modelKey] = !!_win.__kustoMonacoInitializedByModel[modelKey];
						const perModelLoadedSchemas = _win.__kustoMonacoLoadedSchemasByModel[modelKey];
						
						const schemaKey = `${clusterUrl}|${database}`;
						// If this is a force refresh, invalidate the loaded tracking so we reload the schema
						if (forceRefresh && perModelLoadedSchemas[schemaKey]) {
							delete perModelLoadedSchemas[schemaKey];
						}
						const alreadyLoaded = !!perModelLoadedSchemas[schemaKey];
						
						// Normalize cluster URLs for comparison
						const normalizeClusterUrl = (url: any) => {
							if (!url) return '';
							let normalized = String(url).trim().toLowerCase();
							normalized = normalized.replace(/^https?:\/\//, '');
							normalized = normalized.replace(/\/+$/, '');
							return normalized;
						};
						
						// Check if the current worker schema is for the same cluster (per model)
						const currentContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
						const currentClusterNormalized = normalizeClusterUrl(currentContext?.clusterUrl);
						const newClusterNormalized = normalizeClusterUrl(clusterUrl);
						const isSameCluster = currentContext && currentClusterNormalized === newClusterNormalized;
						const isSameDatabase = isSameCluster && currentContext?.database?.toLowerCase() === database?.toLowerCase();
						
						// If already loaded, we might still need to switch context
						// BUT: we need to verify the cluster is still the same - if user switched clusters,
						// the schema was replaced and we need to reload
						if (alreadyLoaded) {
							if (setAsContext) {
								if (!isSameCluster) {
									// Cluster has changed! The schema we "loaded" is no longer in the worker.
									// We need to reload it. Remove from loaded tracking and continue.
									delete perModelLoadedSchemas[schemaKey];
									// Fall through to the loading logic below
								} else if (isSameDatabase) {
									// Same cluster AND same database - nothing to do
									return;
								} else {
									// Same cluster, different database - try to switch context
									const switched = await _win.__kustoSetDatabaseInContext(clusterUrl, database, modelKey);
									if (switched) {
										return;
									}
									// Context switch failed, fall through to do a full schema load
									delete perModelLoadedSchemas[schemaKey];
								}
							} else {
								return;
							}
						}
						
						try {
							if (!rawSchemaJson || !clusterUrl || !database) {
								return;
							}
							
							// Normalize the schema to match showSchema.Result format expected by monaco-kusto
							// The setSchemaFromShowSchema API expects: { Plugins: [], Databases: { ... } }
							let schemaObj = rawSchemaJson;
							if (typeof rawSchemaJson === 'string') {
								try {
									schemaObj = JSON.parse(rawSchemaJson);
								} catch (e) {
									console.error('[monaco-kusto] Failed to parse schema JSON:', e);
									return;
								}
							}
							
							// Ensure the schema has the required Plugins property
							if (schemaObj && schemaObj.Databases && !schemaObj.Plugins) {
								schemaObj = { Plugins: [], ...schemaObj };
							}
							
							// Get the kusto worker through the monaco-kusto API
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								// Add timeout to detect if worker is hung
								const timeoutPromise = new Promise((_, reject) => 
									setTimeout(() => reject(new Error('Timeout getting kusto worker')), 10000)
								);
								
								const workerAccessor = await Promise.race([
									monaco.languages.kusto.getKustoWorker(),
									timeoutPromise
								]);
								
								// Get the worker for THIS model (schema/context are per model URI)
								if (modelKey) {
									const workerPromise = workerAccessor(monaco.Uri.parse(modelKey));
									const worker = await Promise.race([
										workerPromise,
										new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting worker proxy')), 10000))
									]);
									
									if (!worker) {
										return;
									}
									
									// Find the correct database name from the schema (may differ in case)
									let databaseInContext = database;
									if (schemaObj && schemaObj.Databases) {
										const dbKeys = Object.keys(schemaObj.Databases);
										if (!dbKeys.includes(database)) {
											const matchedKey = dbKeys.find(k => k.toLowerCase() === database.toLowerCase());
											if (matchedKey) {
												databaseInContext = matchedKey;
											}
										}
									}
									
													// Use the GLOBAL init flag to decide between set (replace) vs add.
													// setSchemaFromShowSchema replaces the ENTIRE worker schema.
													// We must only use it for the very first schema load across ALL models.
													// After that, use addDatabaseToSchema to avoid wiping other models' schemas.
													if (!_win.__kustoMonacoInitialized) {
										// First schema: use setSchemaFromShowSchema to establish base with database in context
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
																_win.__kustoMonacoInitialized = true; // legacy
																_win.__kustoMonacoInitializedByModel[modelKey] = true;
																perModelLoadedSchemas[schemaKey] = true;
																// Keep legacy/global in sync for debugging only
																_win.__kustoMonacoLoadedSchemas[schemaKey] = true;
																_win.__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
																_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
												
												// Cache the schema for re-adding after cluster switches
												_win.__kustoSchemaCache[schemaKey] = { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
											} catch (schemaError) {
												console.error('[monaco-kusto] setSchemaFromShowSchema failed:', schemaError);
											}
										}
									} else {
										// Subsequent schemas: decide whether to add or replace based on cluster
										// Use the isSameCluster value computed at the top of the function
									
										// If setAsContext is true and we're switching to a different cluster,
										// we need to replace the schema entirely (not add to it)
										// because __kustoSetDatabaseInContext looks for the database in the current cluster's schema.
										// NOTE: forceRefresh deliberately uses the ADD path (addDatabaseToSchema) rather than
										// REPLACE (setSchemaFromShowSchema). REPLACE wipes ALL loaded schemas which breaks
										// fully-qualified cross-cluster/cross-database table references. The ADD path
										// updates just the refreshed database's schema without disturbing others.
										const needsReplace = setAsContext && !isSameCluster;
										if (needsReplace) {
											if (typeof worker.setSchemaFromShowSchema === 'function') {
												try {
																	// Remember what other clusters we had loaded for THIS model before replacing
																	const previouslyLoadedSchemas = { ...perModelLoadedSchemas };
													
													await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
													
																	// Clear loaded schemas tracking for THIS model and cache this new schema
																	try {
																		Object.keys(perModelLoadedSchemas).forEach(k => delete perModelLoadedSchemas[k]);
																	} catch (e) { console.error('[kusto]', e); }
																	perModelLoadedSchemas[schemaKey] = true;
																	// Keep legacy/global in sync for debugging only
																	_win.__kustoMonacoLoadedSchemas = {};
																	_win.__kustoMonacoLoadedSchemas[schemaKey] = true;
																	_win.__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
																	_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
													_win.__kustoSchemaCache[schemaKey] = { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
													
																	// Re-add schemas from OTHER clusters that we have cached.
																	// This keeps cross-cluster database references working after switching.
																	const otherClusterSchemas = Object.keys(_win.__kustoSchemaCache || {})
																		.filter(key => {
																			const [cachedClusterUrl] = key.split('|');
																			const cachedClusterNorm = normalizeClusterUrl(cachedClusterUrl);
																			return cachedClusterNorm && cachedClusterNorm !== newClusterNormalized;
																		});
													
													for (const otherKey of otherClusterSchemas) {
														const cached = _win.__kustoSchemaCache[otherKey];
														if (cached && cached.rawSchemaJson) {
															try {
																// Use addDatabaseToSchema to add this without replacing
																const otherSchemaObj = cached.rawSchemaJson;
																const otherClusterUrl = cached.clusterUrl;
																const otherDatabase = cached.database;
																
																// Normalize and add
																const engineSchema = await worker.normalizeSchema(otherSchemaObj, otherClusterUrl, otherDatabase);
																let databaseSchema = engineSchema?.database;
																if (!databaseSchema && engineSchema?.cluster?.databases) {
																	databaseSchema = engineSchema.cluster.databases.find((db: any) => 
																		db.name.toLowerCase() === otherDatabase.toLowerCase()
																	);
																}
																
																if (databaseSchema) {
																		// Use models[0].uri — guaranteed synced after setSchemaFromShowSchema.
																		const syncedUri = models[0].uri.toString();
																		await worker.addDatabaseToSchema(syncedUri, otherClusterUrl, databaseSchema);
																	// NOTE: Do NOT mark as loaded! Re-added schemas are only for cross-cluster references.
																	// They are NOT primary schemas and need full REPLACE when actually focused.
																} else {
																	// re-add failed - no databaseSchema found
																}
															} catch (readdError) { console.error('[kusto]', readdError); }
														}
													}
													
													// CRITICAL FIX: Clear markers for all boxes that DON'T match the new context
													// setSchemaFromShowSchema validates ALL models against new context, which is wrong for other boxes
													const newClusterNorm = normalizeClusterUrl(clusterUrl);
													const allQueryBoxes = document.querySelectorAll('.query-box[data-box-id]');
													allQueryBoxes.forEach(box => {
														const boxId = box.getAttribute('data-box-id');
														const boxEditor = _win.__kustoEditors?.[boxId as string];
														if (boxEditor) {
															const boxCluster = box.getAttribute('data-cluster-url');
															const boxClusterNorm = boxCluster ? normalizeClusterUrl(boxCluster) : null;
															if (boxClusterNorm && boxClusterNorm !== newClusterNorm) {
																// This box uses a different cluster - clear its markers (they were set with wrong context)
																const boxModel = boxEditor.getModel();
																if (boxModel) {
																	monaco.editor.setModelMarkers(boxModel, 'kusto', []);
																}
															}
														}
													});
													
												} catch (schemaError) {
													console.error('[monaco-kusto] REPLACE: setSchemaFromShowSchema failed:', schemaError);
												}
											}
										} else {
											// Same cluster or not setting as context: use addDatabaseToSchema to ADD without replacing
											//
											// IMPORTANT: The kusto worker schema is GLOBAL — shared across all Monaco models.
											// If another model already loaded this exact schema (same schemaKey), the worker
											// already has it and we can skip the addDatabaseToSchema call entirely.
											// This also avoids "document is null" errors from the worker when the current
											// model's document hasn't been synced to the worker yet.
											const alreadyLoadedGlobally = !forceRefresh && !!_win.__kustoMonacoLoadedSchemas[schemaKey];
											if (alreadyLoadedGlobally) {
												// Schema already in worker from a previous model — just update per-model tracking
												perModelLoadedSchemas[schemaKey] = true;
												_win.__kustoSchemaCache[schemaKey] = _win.__kustoSchemaCache[schemaKey] || { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
												if (setAsContext) {
													await _win.__kustoSetDatabaseInContext(clusterUrl, databaseInContext, modelKey);
												}
											} else if (typeof worker.normalizeSchema === 'function' && typeof worker.addDatabaseToSchema === 'function') {
												try {
													// First normalize the raw schema to get the Database object
													const engineSchema = await worker.normalizeSchema(schemaObj, clusterUrl, databaseInContext);
													
													// Extract the database schema
													let databaseSchema = engineSchema?.database;
													if (!databaseSchema && engineSchema?.cluster?.databases) {
														databaseSchema = engineSchema.cluster.databases.find((db: any) => 
															db.name.toLowerCase() === databaseInContext.toLowerCase()
														);
													}
													
													if (databaseSchema) {
														// Add the database to the existing schema in the worker.
														// Use models[0].uri — the first model is guaranteed to have its document
														// synced from the initial setSchemaFromShowSchema call. The current model
														// (modelKey) may not have been synced yet, causing "document is null" errors.
														// The schema is global in the worker so the URI doesn't affect what's stored.
														const syncedUri = models[0].uri.toString();
														await worker.addDatabaseToSchema(syncedUri, clusterUrl, databaseSchema);
														perModelLoadedSchemas[schemaKey] = true;
														// Keep legacy/global in sync for debugging only
														_win.__kustoMonacoLoadedSchemas[schemaKey] = true;
														_win.__kustoSchemaCache[schemaKey] = { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
														
																	// If requested, also switch context to this database.
																	// NOTE: monaco-kusto's aggregated schema may not include newly-added databases
																	// in currentSchema.cluster.databases. If we rely purely on __kustoSetDatabaseInContext,
																	// context switching can fail and IntelliSense stays on the previous database.
																	if (setAsContext) {
																		let contextSet = false;
																		try {
																			if (typeof worker.getSchema === 'function' && typeof worker.setSchema === 'function') {
																				const currentSchema = await worker.getSchema();
																				const currentDatabases = currentSchema?.cluster?.databases || [];
																				const existingDb = currentDatabases.find((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase());
																				// When the database already exists, replace it with the fresh databaseSchema
																				// (important for forceRefresh — the old entry has stale tables/functions).
																				const nextDatabases = existingDb
																					? currentDatabases.map((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase() ? databaseSchema : db)
																					: [...currentDatabases, databaseSchema];
																				const updatedSchema = {
																					...currentSchema,
																					cluster: {
																						...(currentSchema?.cluster || {}),
																						databases: nextDatabases
																					},
																					database: databaseSchema
																				};
																				await worker.setSchema(updatedSchema);
																				_win.__kustoMonacoDatabaseInContextByModel = _win.__kustoMonacoDatabaseInContextByModel || {};
																				_win.__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: (existingDb || databaseSchema).name };
																				_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
																				contextSet = true;
																			}
																		} catch {
																				contextSet = false;
																		}
																		if (!contextSet) {
																			await _win.__kustoSetDatabaseInContext(clusterUrl, databaseInContext, modelKey);
																		}
																	}
													} else {
														// ADD failed - no databaseSchema found in engineSchema
													}
												} catch (addError) {
													console.error('[monaco-kusto] ADD: addDatabaseToSchema failed:', addError);
												}
											} else {
												// Fallback: just use setSchemaFromShowSchema (will replace, but better than nothing)
												if (typeof worker.setSchemaFromShowSchema === 'function') {
													try {
														await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
																			_win.__kustoMonacoInitialized = true; // legacy
																			_win.__kustoMonacoInitializedByModel[modelKey] = true;
																			perModelLoadedSchemas[schemaKey] = true;
																			_win.__kustoMonacoLoadedSchemas[schemaKey] = true;
														_win.__kustoSchemaCache[schemaKey] = { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
																			_win.__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
																			_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
													} catch (e) {
														console.error('[monaco-kusto] Fallback setSchemaFromShowSchema failed:', e);
													}
												}
											}
										}
									}
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Failed to set schema:', e);
						}
					};
					
					// Function to switch the "database in context" without reloading schemas
					// This allows unqualified table names to resolve to the correct database
					// Returns true if context switch succeeded, false otherwise
					_win.__kustoSetDatabaseInContext = async function (clusterUrl: any, database: any, modelUri = null) {
						// Normalize cluster URLs for comparison
						const normalizeClusterUrl = (url: any) => {
							if (!url) return '';
							let normalized = String(url).trim().toLowerCase();
							normalized = normalized.replace(/^https?:\/\//, '');
							normalized = normalized.replace(/\/+$/, '');
							return normalized;
						};
						
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						if (!models || models.length === 0) {
							return false;
						}
						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : (modelUri as any).toString()) : models[0].uri.toString();
						const currentContext = _win.__kustoMonacoDatabaseInContextByModel?.[modelKey] || _win.__kustoMonacoDatabaseInContext;
						
						// Check if already in this context (use normalized comparison for cluster URL)
						const currentClusterNorm = normalizeClusterUrl(currentContext?.clusterUrl);
						const newClusterNorm = normalizeClusterUrl(clusterUrl);
						if (currentContext && 
							currentClusterNorm === newClusterNorm && 
							currentContext.database?.toLowerCase() === database?.toLowerCase()) {
							return true;
						}
						
						try {
							if (!monaco?.languages?.kusto?.getKustoWorker) {
								return false;
							}
							
							const workerAccessor = await monaco.languages.kusto.getKustoWorker();
							const worker = await workerAccessor(monaco.Uri.parse(modelKey));
							
							if (!worker || typeof worker.getSchema !== 'function' || typeof worker.setSchema !== 'function') {
								return false;
							}
							
							// Get the current aggregated schema
							const currentSchema = await worker.getSchema();

							if (!currentSchema || currentSchema.clusterType !== 'Engine') {
								return false;
							}
							
							const databases = currentSchema.cluster?.databases || [];
							
							// Find the database to set as context
							const targetDatabase = databases.find((db: any) => 
								db.name.toLowerCase() === database.toLowerCase()
							);
							
							if (!targetDatabase) {
								// Database not found in primary cluster's databases.
								// This can happen when the database was added via addDatabaseToSchema for a different cluster.
								// Returning false signals the caller to do a full schema reload.
								return false;
							}
							
							// Create updated schema with new database in context
							const updatedSchema = {
								...currentSchema,
								database: targetDatabase
							};
							
							await worker.setSchema(updatedSchema);
							
							_win.__kustoMonacoDatabaseInContextByModel = _win.__kustoMonacoDatabaseInContextByModel || {};
							_win.__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: targetDatabase.name };
							_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[modelKey];
							return true;
							
						} catch (e) {
							console.error('[monaco-kusto] Error setting database in context:', e);
							return false;
						}
					};

					// Function to update monaco-kusto schema when the user focuses a different query box
					// This ensures the schema is loaded AND switches the "database in context"
					// so unqualified table names resolve correctly for the focused query box
					// enableMarkers: if true (default), enables red squiggles for this box; set to false
					//                when just making a section visible without giving it focus
					_win.__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true) {
						try {
							if (!boxId) return;
							
							// Debounce: track the most recent focus request
							// If another focus came in for the same box, skip duplicate processing
							_win.__kustoLastFocusedBoxId = _win.__kustoLastFocusedBoxId || null;
							_win.__kustoFocusInProgress = _win.__kustoFocusInProgress || null;
							
							// If we're already processing this exact box, skip
							if (_win.__kustoFocusInProgress === boxId) {
								return;
							}
							
							_win.__kustoFocusInProgress = boxId;
							
							// Mark worker as initialized once a query box gets focus
							_win.__kustoWorkerInitialized = true;
							
							// If we need to reload schemas after tab became visible, do it now
							if (_win.__kustoWorkerNeedsSchemaReload) {
								_win.__kustoWorkerNeedsSchemaReload = false;
								
								// Re-request schema for the focused box (this will trigger load)
								// Other box schemas will be loaded when they get focus
							}
							
							// Get the connection and database for this box
							let ownerId = boxId;
							try {
								if (typeof _win.__kustoGetSelectionOwnerBoxId === 'function') {
									ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
								}
							} catch (e) { console.error('[kusto]', e); }
							
							const connectionId = _win.__kustoGetConnectionId ? _win.__kustoGetConnectionId(ownerId) : '';
							const database = _win.__kustoGetDatabase ? _win.__kustoGetDatabase(ownerId) : '';
							
							// Only enable markers (red squiggles) if both cluster and database are selected.
							// Without a full connection context, diagnostics would show false positives.
							if (!connectionId || !database) {
								return;
							}
							
							// Enable markers for this editor's model AFTER confirming connection context (lazy diagnostics)
							// This allows red squiggles to show after focus, but only when we have schema context
							// Only enable if explicitly requested (i.e., on actual focus, not just visibility)
							if (enableMarkers) {
								_win.__kustoEnableMarkersForBox(boxId);
							}
							
							// Get the cluster URL for this connection
							const conn = Array.isArray(_win.connections) ? _win.connections.find(c => c && String(c.id || '') === connectionId) : null;
							const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
							
							if (!clusterUrl) {
								return;
							}
							
							let focusedModelUri = null;
							// Register model→cluster mapping for marker suppression
							// This allows the interceptor to suppress markers for models that don't match current context
							try {
								const editor = typeof _win.queryEditors !== 'undefined' ? _win.queryEditors[boxId] : null;
								if (editor && typeof editor.getModel === 'function') {
									const model = editor.getModel();
									if (model && model.uri) {
										const modelUri = model.uri.toString();
										focusedModelUri = modelUri;
										_win.__kustoModelClusterMap = _win.__kustoModelClusterMap || {};
										_win.__kustoModelClusterMap[modelUri] = clusterUrl;
									}
								}
							} catch (e) { console.error('[kusto]', e); }
							
							if (!focusedModelUri) {
								return;
							}
							
							const schemaKey = `${clusterUrl}|${database}`;
							const currentContextForModel = _win.__kustoMonacoDatabaseInContextByModel?.[focusedModelUri] || _win.__kustoMonacoDatabaseInContext;
											
							// Check if this schema is already loaded in the worker
							const perModelLoaded = _win.__kustoMonacoLoadedSchemasByModel?.[focusedModelUri] || {};
							const alreadyLoaded = !!perModelLoaded[schemaKey];
							// Get rawSchemaJson from the existing schema cache (schemaByBoxId)
							// This is the single source of truth - no duplicate caching
							const schema = typeof _win.schemaByBoxId !== 'undefined' ? _win.schemaByBoxId[boxId] : null;
							const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
							
							if (alreadyLoaded) {
								// Schema is marked as loaded, but we need to verify the cluster is still the same
								// If user switched clusters, the worker schema was replaced and we need to reload
								const currentContext = currentContextForModel;
								
								// Normalize cluster URLs for comparison
								const normalizeClusterUrl = (url: any) => {
									if (!url) return '';
									let normalized = String(url).trim().toLowerCase();
									normalized = normalized.replace(/^https?:\/\//, '');
									normalized = normalized.replace(/\/+$/, '');
									return normalized;
								};
								
								const currentClusterNormalized = normalizeClusterUrl(currentContext?.clusterUrl);
								const focusedClusterNormalized = normalizeClusterUrl(clusterUrl);
								const isSameCluster = currentContext && currentClusterNormalized === focusedClusterNormalized;
								
								if (!isSameCluster) {
									// Cluster changed! The "loaded" schema is no longer in the worker.
									// Remove from loaded tracking and fall through to loading logic
									try {
										delete perModelLoaded[schemaKey];
									} catch (e) { console.error('[kusto]', e); }
									// Continue to the loading logic below instead of returning
								} else {
									// Same cluster, try to switch context
									let contextSwitched = false;
									if (typeof _win.__kustoSetDatabaseInContext === 'function') {
										contextSwitched = await _win.__kustoSetDatabaseInContext(clusterUrl, database, focusedModelUri);
									}
									
									if (contextSwitched) {
										// Context switch succeeded, trigger re-validation
										_win.__kustoTriggerRevalidation(boxId);
										return;
									} else {
										// Context switch failed (database not found in current schema)
										// This can happen when databases get out of sync.
										// Fall through to do a full schema reload.
										try {
											delete perModelLoaded[schemaKey];
										} catch (e) { console.error('[kusto]', e); }
									}
								}
							}
							
							if (rawSchemaJson) {
								// Load the schema AND set as context (setAsContext = true).
								// Use setSchemaFromShowSchema directly to GUARANTEE the correct
								// database is set as context. The addDatabaseToSchema path can
								// fail to switch context if the worker state was replaced by
								// another model's setSchemaFromShowSchema during initial load.
								try {
									if (monaco?.languages?.kusto?.getKustoWorker) {
										const workerAccessor = await monaco.languages.kusto.getKustoWorker();
										const worker = await workerAccessor(monaco.Uri.parse(focusedModelUri));
										if (worker && typeof worker.setSchemaFromShowSchema === 'function') {
											let schemaObj = rawSchemaJson;
											if (typeof schemaObj === 'string') {
												try { schemaObj = JSON.parse(schemaObj); } catch (e) { console.error('[kusto]', e); }
											}
											if (schemaObj && schemaObj.Databases && !schemaObj.Plugins) {
												schemaObj = { Plugins: [], ...schemaObj };
											}
											let databaseInContext = database;
											if (schemaObj?.Databases) {
												const dbKeys = Object.keys(schemaObj.Databases);
												const matchedKey = dbKeys.find((k: string) => k.toLowerCase() === database.toLowerCase());
												if (matchedKey) databaseInContext = matchedKey;
											}
											await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);

											// Update tracking state
											_win.__kustoMonacoInitializedByModel = _win.__kustoMonacoInitializedByModel || {};
											_win.__kustoMonacoInitializedByModel[focusedModelUri] = true;
											const pl = _win.__kustoMonacoLoadedSchemasByModel?.[focusedModelUri] || {};
											pl[schemaKey] = true;
											if (_win.__kustoMonacoLoadedSchemasByModel) {
												_win.__kustoMonacoLoadedSchemasByModel[focusedModelUri] = pl;
											}
											_win.__kustoMonacoDatabaseInContextByModel = _win.__kustoMonacoDatabaseInContextByModel || {};
											_win.__kustoMonacoDatabaseInContextByModel[focusedModelUri] = { clusterUrl, database: databaseInContext };
											_win.__kustoMonacoDatabaseInContext = _win.__kustoMonacoDatabaseInContextByModel[focusedModelUri];
											_win.__kustoSchemaCache = _win.__kustoSchemaCache || {};
											_win.__kustoSchemaCache[schemaKey] = { rawSchemaJson: schemaObj, clusterUrl, database: databaseInContext };
										}
									}
								} catch (e) {
									// Fallback: try the queued path
									if (typeof _win.__kustoSetMonacoKustoSchema === 'function') {
										await _win.__kustoSetMonacoKustoSchema(rawSchemaJson, clusterUrl, database, true, focusedModelUri);
									}
								}
								
								// Trigger re-validation with the newly loaded schema
								_win.__kustoTriggerRevalidation(boxId);
							} else {
								// Request a fresh schema fetch which will include rawSchemaJson
								// Markers will be enabled when schema loads
								if (typeof _win.ensureSchemaForBox === 'function') {
									_win.ensureSchemaForBox(boxId, true); // force refresh to get rawSchemaJson
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Error updating schema for focused box:', e);
						} finally {
							// Clear the in-progress flag
							if (_win.__kustoFocusInProgress === boxId) {
								_win.__kustoFocusInProgress = null;
							}
						}
					};
					
					// Helper to enable markers for a specific box's editor
					_win.__kustoEnableMarkersForBox = function(boxId: any) {
						try {
							const editor = typeof _win.queryEditors !== 'undefined' ? _win.queryEditors[boxId] : null;
							if (editor && typeof editor.getModel === 'function') {
								const model = editor.getModel();
								if (model && model.uri) {
									if (typeof _win.__kustoEnableMarkersForModel === 'function') {
										_win.__kustoEnableMarkersForModel(model.uri);
									}
								}
							}
						} catch (e) { console.error('[kusto]', e); }
					};
					
					// Helper to trigger re-validation for a specific box's editor
					// This is needed after context switch since monaco-kusto doesn't auto-revalidate
					_win.__kustoTriggerRevalidation = function(boxId: any) {
						try {
							const editor = typeof _win.queryEditors !== 'undefined' ? _win.queryEditors[boxId] : null;
							if (editor && typeof editor.getModel === 'function') {
								const model = editor.getModel();
								if (model) {
									try {
										// Clear existing markers first
										monaco.editor.setModelMarkers(model, 'kusto', []);
									} catch (e) { console.error('[kusto]', e); }
								}
							}
						} catch (e) { console.error('[kusto]', e); }
					};

					// Track which cross-cluster schemas have been loaded or requested
					// Key: "clusterName|database" -> { status: 'pending'|'loaded'|'error', rawSchemaJson?: object }
					_win.__kustoCrossClusterSchemas = {};

					// Parse query text to extract cluster() and database() references
					// Returns array of { clusterName, database } objects
					_win.__kustoExtractCrossClusterRefs = function (queryText: any) {
						const refs: any[] = [];
						if (!queryText || typeof queryText !== 'string') {
							return refs;
						}

						// Pattern 1: cluster('name').database('dbname')
						// cluster("name").database("dbname")
						// cluster(name).database(dbname) - without quotes
						const clusterDbPattern = /cluster\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)\s*\.\s*database\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
						let match;
						while ((match = clusterDbPattern.exec(queryText)) !== null) {
							const clusterName = match[1];
							const database = match[2];
							if (clusterName && database) {
								// Avoid duplicates
								const exists = refs.some(r => 
									r.clusterName.toLowerCase() === clusterName.toLowerCase() &&
									r.database.toLowerCase() === database.toLowerCase()
								);
								if (!exists) {
									refs.push({ clusterName, database });
								}
							}
						}
						
						// Pattern 2: database('name') without cluster() prefix
						// This references a database on the SAME cluster as the current connection
						// We'll mark these with clusterName = null and resolve the cluster later
						const dbOnlyPattern = /(?<!cluster\s*\([^)]*\)\s*\.)\bdatabase\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
						while ((match = dbOnlyPattern.exec(queryText)) !== null) {
							const database = match[1];
							if (database) {
								// Check if this database is different from the current context
								const currentDb = _win.__kustoMonacoDatabaseInContext?.database;
								if (database.toLowerCase() !== currentDb?.toLowerCase()) {
									const exists = refs.some(r => 
										r.clusterName === null &&
										r.database.toLowerCase() === database.toLowerCase()
									);
									if (!exists) {
										refs.push({ clusterName: null, database }); // null means "same cluster"
									}
								}
							}
						}
						
						return refs;
					};

					// Request schema for a cross-cluster reference
					_win.__kustoRequestCrossClusterSchema = function (clusterName: any, database: any, boxId: any) {
						// If clusterName is null, resolve it from current context
						let resolvedClusterName = clusterName;
						if (clusterName === null) {
							const currentContext = _win.__kustoMonacoDatabaseInContext;
							if (currentContext?.clusterUrl) {
								// Extract cluster name from URL (e.g., https://ddtelvscode.kusto.windows.net -> ddtelvscode)
								const urlMatch = currentContext.clusterUrl.match(/https?:\/\/([^.]+)/i);
								resolvedClusterName = urlMatch ? urlMatch[1] : currentContext.clusterUrl;
							} else {
								return;
							}
						}
						
						const key = `${resolvedClusterName.toLowerCase()}|${database.toLowerCase()}`;
						
						// Skip if already loaded or pending
						if (_win.__kustoCrossClusterSchemas[key]) {
							return;
						}

						// Mark as pending
						_win.__kustoCrossClusterSchemas[key] = { status: 'pending' };

						const requestToken = 'crosscluster_' + Date.now() + '_' + Math.random().toString(16).slice(2);
						
						if (typeof _win.vscode !== 'undefined' && _win.vscode.postMessage) {
							_win.vscode.postMessage({
								type: 'requestCrossClusterSchema',
								clusterName: resolvedClusterName,
								database,
								boxId: boxId || '',
								requestToken
							});
						}
					};

					// Apply a cross-cluster schema to monaco-kusto
					// This is serialized through the same queue as __kustoSetMonacoKustoSchema to prevent races
					_win.__kustoApplyCrossClusterSchema = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any) {
						// Serialize through the same queue as primary schema operations
						const operationPromise = _win.__kustoSchemaOperationQueue.then(async () => {
							return await _win.__kustoApplyCrossClusterSchemaInternal(clusterName, clusterUrl, database, rawSchemaJson);
						}).catch((e: any) => {
							console.error('[monaco-kusto] Cross-cluster schema operation failed:', e);
						});
						_win.__kustoSchemaOperationQueue = operationPromise;
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
					_win.__kustoApplyCrossClusterSchemaInternal = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any) {
						const key = `${clusterName.toLowerCase()}|${database.toLowerCase()}`;
						
						try {
							// Parse the raw schema JSON
							let schemaObj;
							if (typeof rawSchemaJson === 'string') {
								try {
									schemaObj = JSON.parse(rawSchemaJson);
								} catch (e) {
									console.error('[monaco-kusto] Failed to parse cross-cluster schema JSON:', e);
									_win.__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Failed to parse schema' };
									return;
								}
							} else {
								schemaObj = rawSchemaJson;
							}

							if (!schemaObj || !schemaObj.Databases) {
								_win.__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Invalid schema format' };
								return;
							}

							// Get the kusto worker
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								const workerAccessor = await monaco.languages.kusto.getKustoWorker();
								const models = monaco.editor.getModels();
								
								if (models && models.length > 0) {
													// Convert showSchema format to Database format for addDatabaseToSchema
													// The raw schema has Databases as object: { "dbname": { Tables: {...}, Functions: {...}, ... } }
													const dbSchema = schemaObj.Databases[database] || Object.values(schemaObj.Databases)[0];
													
													if (dbSchema) {
														// Convert to the Database interface format expected by addDatabaseToSchema
														const databaseSchema = {
												name: database,
												tables: Object.entries(dbSchema.Tables || {}).map(([name, table]) => ({
													name,
													entityType: (table as any).EntityType || 'Table',
													columns: Object.entries((table as any).OrderedColumns || {}).map(([colName, col]) => ({
														name: (col as any).Name || colName,
														type: (col as any).CslType || (col as any).Type || 'string',
														docstring: (col as any).Docstring || ''
													})),
													docstring: (table as any).Docstring || ''
												})),
												functions: Object.entries(dbSchema.Functions || {}).map(([name, func]) => ({
													name,
													inputParameters: ((func as any).InputParameters || []).map((p: any) => ({
														name: p.Name || '',
														type: p.CslType || p.Type || 'string',
														cslDefaultValue: p.CslDefaultValue
													})),
													body: (func as any).Body || '',
													docstring: (func as any).Docstring || ''
												})),
												graphs: [], // Empty for now, could be populated from ExternalTables or similar
												entityGroups: [], // Empty for now
												majorVersion: 1,
												minorVersion: 0
											};
												
// The kusto worker schema is GLOBAL — one addDatabaseToSchema call
															// applies to all models. Use models[0].uri which is guaranteed to
															// have its document synced (avoids "document is null" errors).
															const loadedKey = `${clusterUrl}|${database}`;
															let appliedCount = 0;
															try {
																const syncedModel = models[0];
																const worker2 = await workerAccessor(syncedModel.uri);
																if (worker2 && typeof worker2.addDatabaseToSchema === 'function') {
																	await worker2.addDatabaseToSchema(syncedModel.uri.toString(), clusterName, databaseSchema);
																	appliedCount++;
																}
															} catch (e) { console.error('[kusto]', e); }
															// Update per-model tracking for ALL models
															if (appliedCount > 0) {
																for (const model of models) {
																	_win.__kustoMonacoLoadedSchemasByModel = _win.__kustoMonacoLoadedSchemasByModel || {};
																	_win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()] = _win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()] || {};
																	_win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()][loadedKey] = true;
																}
																}
																// Keep legacy/global in sync for debugging only
																_win.__kustoMonacoLoadedSchemas = _win.__kustoMonacoLoadedSchemas || {};
																_win.__kustoMonacoLoadedSchemas[loadedKey] = true;
												
																if (appliedCount > 0) {
																	_win.__kustoCrossClusterSchemas[key] = { 
																		status: 'loaded', 
																		rawSchemaJson: schemaObj,
																		clusterUrl
																	};
																} else {
																	_win.__kustoCrossClusterSchemas[key] = { status: 'error', error: 'API not available' };
																}
											
											// Show notification to user that cross-cluster schema was loaded
											try {
												if (typeof _win.vscode !== 'undefined' && _win.vscode.postMessage) {
													_win.vscode.postMessage({
														type: 'showInfo',
														message: `Schema loaded for cluster('${clusterName}').database('${database}') — autocomplete is now available.`
													});
												}
											} catch (e) { console.error('[kusto]', e); }
													} else {
														_win.__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Database not found in schema' };
													}
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Failed to apply cross-cluster schema:', e);
							_win.__kustoCrossClusterSchemas[key] = { status: 'error', error: String(e) };
						}
					};

					// Check for cross-cluster references in a query and request schemas
					_win.__kustoCheckCrossClusterRefs = function (queryText: any, boxId: any) {
						const refs = _win.__kustoExtractCrossClusterRefs(queryText);
						for (const ref of refs) {
							_win.__kustoRequestCrossClusterSchema(ref.clusterName, ref.database, boxId);
						}
					};

					// --- Automatically trigger Copilot inline completions Provider ---
					// Provides ghost-text completions using GitHub Copilot via the VS Code extension host
					let __kustoInlineCompletionRequestId = 0;
					monaco.languages.registerInlineCompletionsProvider('kusto', {
						provideInlineCompletions: async function (model: any, position: any, context: any, token: any) {
							try {
								// triggerKind: 0 = automatic, 1 = manual (explicit)
								const isManualTrigger = context && context.triggerKind === 1;

								// Check if automatic inline completions are enabled
								// The toggle only controls automatic triggers - manual triggers (SHIFT+SPACE) always work
								if (!isManualTrigger && typeof _win.copilotInlineCompletionsEnabled !== 'undefined' && !_win.copilotInlineCompletionsEnabled) {
									return { items: [] };
								}

								// Don't provide completions if we're in a comment
								const lineContent = model.getLineContent(position.lineNumber);
								const textBeforeOnLine = lineContent.substring(0, position.column - 1);
								if (textBeforeOnLine.includes('//')) {
									return { items: [] };
								}

								// Get text before and after cursor
								const fullText = model.getValue();
								const offset = model.getOffsetAt(position);
								const textBefore = fullText.substring(0, offset);
								const textAfter = fullText.substring(offset);

								// Don't trigger if line is empty and we're at the start
								if (!textBefore.trim() && !textAfter.trim()) {
									return { items: [] };
								}

								// Generate a unique request ID
								const requestId = 'inline_' + (++__kustoInlineCompletionRequestId) + '_' + Date.now();

								// Find the boxId for this model
								let boxId = '';
								try {
									const modelUri = model.uri ? model.uri.toString() : '';
									if (typeof _win.queryEditorBoxByModelUri !== 'undefined' && modelUri) {
										boxId = _win.queryEditorBoxByModelUri[modelUri] || '';
									}
								} catch (e) { console.error('[kusto]', e); }

								// Create a promise that will be resolved when we get the response
								const completionPromise = new Promise((resolve) => {
									// Set a timeout to avoid hanging
									const timeoutId = setTimeout(() => {
										delete _win.copilotInlineCompletionRequests[requestId];
										resolve([]);
									}, 5000);

									_win.copilotInlineCompletionRequests[requestId] = {
										resolve: (completions: any) => {
											clearTimeout(timeoutId);
											resolve(completions);
										}
									};

									// Handle cancellation
									if (token && typeof token.onCancellationRequested === 'function') {
										token.onCancellationRequested(() => {
											clearTimeout(timeoutId);
											delete _win.copilotInlineCompletionRequests[requestId];
											resolve([]);
										});
									}
								});

								// Request completion from extension
								console.log('[Kusto] Sending inline completion request', { requestId, boxId, textBeforeLen: textBefore.length, isManualTrigger });
								try {
									_win.vscode!.postMessage({
										type: 'requestCopilotInlineCompletion',
										requestId: requestId,
										boxId: boxId,
										textBefore: textBefore,
										textAfter: textAfter
									});
								} catch (err) {
									console.error('[Kusto] Failed to send inline completion request', err);
									return { items: [] };
								}

								// Wait for response
								const completions = await completionPromise;
								console.log('[Kusto] Received completions', completions);
								if (!completions || !Array.isArray(completions) || completions.length === 0) {
									console.log('[Kusto] No completions returned');
									// Show notification only for manual triggers (SHIFT+SPACE)
									if (isManualTrigger) {
										try {
											_win.vscode!.postMessage({
												type: 'showInfo',
												message: 'Copilot returned no inline suggestions. Often, trying again helps, especially after changing the position of the cursor.'
											});
										} catch (e) { console.error('[kusto]', e); }
									}
									return { items: [] };
								}

								// Convert to Monaco inline completion items
								const items = completions.map(c => ({
									insertText: c.insertText || '',
									range: new monaco.Range(
										position.lineNumber,
										position.column,
										position.lineNumber,
										position.column
									)
								})).filter(item => item.insertText);

								return { items };
							} catch {
								return { items: [] };
							}
						},
						freeInlineCompletions: function (completions: any) {
							// No cleanup needed
						}
					});
					
					_win.__kustoWorkerInitialized = true;
					
					// Start the theme observer to handle dynamic theme changes in VS Code
					startMonacoThemeObserver(monaco);
					
					resolve(monaco);
								} catch (e) {
									reject(e);
								}
							}, (e: any) => reject(e)); // monaco-kusto load error handler
						} catch (e) {
							reject(e);
						}
					},
					(e: any) => reject(e)
				);
			}).catch((e) => reject(e));
		} catch (e) {
			reject(e);
		}
	});

	// If Monaco init fails, allow retries within the same webview session.
	_win.monacoReadyPromise = _win.monacoReadyPromise.catch((e: any) => {
		try { _win.monacoReadyPromise = null; } catch (e) { console.error('[kusto]', e); }
		throw e;
	});

	return _win.monacoReadyPromise;
}

// Lazy loading state tracking
// Monaco+Kusto worker is NOT loaded until user focuses a query box
// This saves memory when files are opened but not actively edited
_win.__kustoWorkerInitialized = false;
_win.__kustoWorkerNeedsSchemaReload = false; // Set to true when tab becomes visible after being hidden

// Proactively start loading Monaco as soon as this script is loaded.
// This reduces the time the UI appears as a non-interactive placeholder before the editor mounts.
// NOTE: Now disabled by default for lazy loading - Monaco will load on first editor creation
// Set _win.__kustoPreloadMonaco = true before this script loads to enable pre-warming
try {
	if (_win.__kustoPreloadMonaco) {
		setTimeout(() => {
			try {
				const p = ensureMonaco();
				if (p && typeof p.catch === 'function') {
					p.catch(() => { /* ignore */ });
				}
			} catch (e) { console.error('[kusto]', e); }
		}, 0);
	}
} catch (e) { console.error('[kusto]', e); }

// Tab visibility change listener - clear schemas when tab is hidden to save memory
// Schemas will be reloaded when user focuses a query box after tab becomes visible
try {
	document.addEventListener('visibilitychange', () => {
		try {
			if (document.hidden) {
				// Tab is being hidden - clear the loaded schemas from worker memory
				// This frees significant memory while keeping the basic worker alive
				
				// Mark that we need to reload schemas on next focus
				_win.__kustoWorkerNeedsSchemaReload = true;
				
				// Clear the loaded schemas tracking
				if (_win.__kustoMonacoLoadedSchemas) {
					_win.__kustoMonacoLoadedSchemas = {};
				}
				// Clear per-model tracking too (Monaco model URIs can be reused)
				try { _win.__kustoMonacoLoadedSchemasByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { _win.__kustoMonacoDatabaseInContextByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { _win.__kustoMonacoInitializedByModel = {}; } catch (e) { console.error('[kusto]', e); }
				_win.__kustoMonacoDatabaseInContext = null;
				
				// Optionally: Clear the schema from the worker to free memory
				// This is async and may not complete before tab switch, but it's best effort
				(async () => {
					try {
						if (typeof monaco !== 'undefined' && monaco && monaco.languages && monaco.languages.kusto && 
							typeof monaco.languages.kusto.getKustoWorker === 'function') {
							const workerAccessor = await monaco.languages.kusto.getKustoWorker();
							const models = monaco.editor.getModels();
										if (models && models.length > 0 && workerAccessor) {
											for (const model of models) {
												try {
													const worker = await workerAccessor(model.uri);
													if (worker && typeof worker.setSchema === 'function') {
														// Set an empty schema to free memory
														await worker.setSchema({ cluster: { connectionString: '', databases: [] } });
													}
												} catch (e) { console.error('[kusto]', e); }
											}
										}
						}
					} catch (e) { console.error('[kusto]', e); }
				})();
			}
			// Tab became visible - don't reload yet, wait for user to focus a query box
		} catch (e) { console.error('[kusto]', e); }
	}, true);
} catch (e) { console.error('[kusto]', e); }

function initQueryEditor(boxId: any) {
	return ensureMonaco().then((monaco: any) => {
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
			} catch (e) { console.error('[kusto]', e); }
		};

		// If an editor instance already exists, ensure it's still attached to this container.
		// If it's stale (detached due to DOM teardown), dispose and recreate.
		try {
			const existing = _win.queryEditors && _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch (e) { console.error('[kusto]', e); }
				try { delete _win.queryEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Ensure flex sizing doesn't allow the editor container to expand with content.
		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// If persistence restore ran before Monaco init, apply the restored wrapper height now.
		// This avoids layout glitches when the Copilot split-pane is installed.
		try {
			const pending = _win.__kustoPendingWrapperHeightPxByBoxId && _win.__kustoPendingWrapperHeightPxByBoxId[boxId];
			if (typeof pending === 'number' && Number.isFinite(pending) && pending > 0) {
				let w = wrapper;
				if (!w) {
					const box = document.getElementById(boxId);
					w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
				}
				if (w) {
					(w as any).style.height = Math.round(pending) + 'px';
					try { (w as any).dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
					// Also update the manual height map so __kustoGetWrapperHeightPx returns consistent values.
					try {
						if (!_win.__kustoManualQueryEditorHeightPxByBoxId || typeof _win.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
							_win.__kustoManualQueryEditorHeightPxByBoxId = {};
						}
						_win.__kustoManualQueryEditorHeightPxByBoxId[boxId] = Math.round(pending);
					} catch (e) { console.error('[kusto]', e); }
				}
				try { delete _win.__kustoPendingWrapperHeightPxByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Avoid calling editor.setValue() during initialization; pass initial value into create()
		// to reduce async timing races in VS Code webviews.
		let initialValue = '';
		try {
			const pending = _win.__kustoPendingQueryTextByBoxId && _win.__kustoPendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete _win.__kustoPendingQueryTextByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'kusto',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			scrollbar: { alwaysConsumeMouseWheel: false },
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
			// Disable Monaco's built-in context menu — most items (Go to Definition, Rename,
			// Format, etc.) have no providers in this webview and silently do nothing.
			// We provide a custom context menu with only the actions that actually work.
			contextmenu: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none',
			// Enable inline suggestions (ghost text completions from Copilot)
			inlineSuggest: { enabled: true }
		});

		// Keep Monaco's suggest widget usable inside the editor bounds.
		try { __kustoInstallSmartSuggestWidgetSizing(editor); } catch (e) { console.error('[kusto]', e); }

		// Single diagnostics tooltip (replaces Monaco's default hover widget).
		try {
			// monaco-kusto uses the language ID 'kusto' as the marker owner
			const DIAG_OWNER = 'kusto';
			const DIAG_HOVER_SHOW_DELAY_MS = 1000;
			let diagHoverEl: any = null;
			let diagHoverLastKey = '';
			let diagHoverHideTimer: any = null;
			let diagHoverShowTimer: any = null;
			let diagHoverPending: any = null;
			let diagHoverLastMouse = { at: 0, clientX: 0, clientY: 0, position: null };
			let diagHoverLastCursor = { at: 0, position: null };
			let diagHoverActiveSource = null; // 'mouse' | 'cursor'

			const ensureDiagHoverEl = () => {
				if (diagHoverEl) return diagHoverEl;
				const el = document.createElement('div');
				el.className = 'kusto-doc-widget kusto-diagnostics-hover';
				(el as any).style.position = 'fixed';
				(el as any).style.display = 'none';
				(el as any).style.pointerEvents = 'none';
				// Keep above the editor but below Monaco context widgets (quick fix / lightbulb menu).
				(el as any).style.zIndex = '1000';
				document.body.appendChild(el);
				diagHoverEl = el;
				return el;
			};

			const hideDiagHover = (immediate: any) => {
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
						} catch (e) { console.error('[kusto]', e); }
					}, 50);
				} catch (e) { console.error('[kusto]', e); }
			};

			const getDiagnosticAt = (model: any, position: any) => {
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

			const formatDiagMessageHtml = (msg: any) => {
				const raw = String(msg || '').trim();
				const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(raw) : raw;
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

			const positionDiagHover = (el: any, clientX: any, clientY: any) => {
				try {
					const pad = 12;
					const maxW = 560;
					(el as any).style.maxWidth = maxW + 'px';
					(el as any).style.left = '0px';
					(el as any).style.top = '0px';
					(el as any).style.display = 'block';
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
					(el as any).style.left = Math.round(x) + 'px';
					(el as any).style.top = Math.round(y) + 'px';
				} catch (e) { console.error('[kusto]', e); }
			};

			const getClientPointForCursor = (pos: any) => {
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

			const showDiagHover = (marker: any, mouseEventOrPoint: any) => {
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
					(el as any).style.display = 'block';
					const be = mouseEventOrPoint && mouseEventOrPoint.browserEvent ? mouseEventOrPoint.browserEvent : null;
					const cx = be ? be.clientX : (mouseEventOrPoint && typeof mouseEventOrPoint.clientX === 'number' ? mouseEventOrPoint.clientX : 0);
					const cy = be ? be.clientY : (mouseEventOrPoint && typeof mouseEventOrPoint.clientY === 'number' ? mouseEventOrPoint.clientY : 0);
					positionDiagHover(el, cx, cy);
				} catch (e) { console.error('[kusto]', e); }
			};

			const scheduleDiagHover = (marker: any, point: any, source: any) => {
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
							} catch (e) { console.error('[kusto]', e); }
							if (computeActiveSource() !== 'cursor') return;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos) return;
							const current = getDiagnosticAt(model, pos);
							if (!current) return;
							const curKey = String(current.code || '') + '|' + String(current.message || '') + '|' + current.startLineNumber + ':' + current.startColumn + '-' + current.endLineNumber + ':' + current.endColumn;
							if (curKey !== pending.key) return;
							showDiagHover(current, pending.point);
						} catch (e) { console.error('[kusto]', e); }
					}, DIAG_HOVER_SHOW_DELAY_MS);
				} catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
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
				editor.onMouseMove((e: any) => {
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
						} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }

			// Hook cursor moves (keyboard or programmatic) to show diagnostics at caret.
			try {
				editor.onDidChangeCursorPosition((e: any) => {
					try {
						diagHoverLastCursor.at = Date.now();
						diagHoverLastCursor.position = e && e.position ? e.position : null;
						refreshDiagHoverFromActiveSource();
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }

			// If mouse is the active source, refresh when we scroll.
			try {
				editor.onDidScrollChange(() => {
					try {
						if (computeActiveSource() === 'cursor') {
							refreshDiagHoverFromActiveSource();
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch (e) { console.error('[kusto]', e); }

			try {
				editor.onMouseLeave(() => hideDiagHover(true));
			} catch (e) { console.error('[kusto]', e); }
			try {
				editor.onDidBlurEditorText(() => hideDiagHover(true));
			} catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }

		// Active statement indicator (only when multi-statement via blank-line separators).
		// We intentionally avoid a background highlight; instead, we draw a subtle gutter bar.
		try {
			// Shared statement splitting helpers.
			// - A "blank line" is a line containing only whitespace.
			// - Statements are separated by one-or-more blank lines (the existing behavior).
			// This must match Run Query behavior and the gutter indicator.
			try {
				if (typeof _win.__kustoStatementSeparatorMinBlankLines !== 'number') {
					_win.__kustoStatementSeparatorMinBlankLines = 1;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoGetStatementBlocksFromModel !== 'function') {
					_win.__kustoGetStatementBlocksFromModel = function (model: any) {
						try {
							if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return [];
							const minBlankLines = Math.max(1, Number(_win.__kustoStatementSeparatorMinBlankLines) || 1);
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							if (!lineCount) return [];
							const blocks = [];
							let startLine = null;
							let lastNonBlankLine = null;
							let blankRun = 0;
							let inTripleBacktick = false;
							for (let ln = 1; ln <= lineCount; ln++) {
								const lineText = String(model.getLineContent(ln) || '');
								// Track triple-backtick (```) multi-line string literals.
								// Count occurrences of ``` on this line to toggle the state;
								// an odd count flips the state, an even count keeps it unchanged.
								let tripleCount = 0;
								for (let ci = 0; ci < lineText.length - 2; ci++) {
									if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
										tripleCount++;
										ci += 2; // skip past the triple
									}
								}
								if (tripleCount % 2 === 1) {
									inTripleBacktick = !inTripleBacktick;
								}
								// While inside a triple-backtick string, blank lines are NOT separators.
								if (inTripleBacktick) {
									if (startLine === null) startLine = ln;
									lastNonBlankLine = ln;
									blankRun = 0;
									continue;
								}
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
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoIsSeparatorBlankLine !== 'function') {
					_win.__kustoIsSeparatorBlankLine = function (model: any, lineNumber: any) {
						try {
							if (!model || typeof model.getLineContent !== 'function' || typeof model.getLineCount !== 'function') return false;
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							const ln = Number(lineNumber) || 0;
							if (!ln || ln < 1 || ln > lineCount) return false;
							const minBlankLines = Math.max(1, Number(_win.__kustoStatementSeparatorMinBlankLines) || 1);
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
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoExtractStatementTextAtCursor !== 'function') {
					_win.__kustoExtractStatementTextAtCursor = function (editor: any) {
						try {
							if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos || !pos.lineNumber) return null;
							const cursorLine = Number(pos.lineNumber) || 0;
							if (!cursorLine || cursorLine < 1) return null;
							// If the cursor is on a separator (2+ blank lines), treat as "no statement".
							try {
								if (_win.__kustoIsSeparatorBlankLine && _win.__kustoIsSeparatorBlankLine(model, cursorLine)) {
									return null;
								}
							} catch (e) { console.error('[kusto]', e); }
							const blocks = (_win.__kustoGetStatementBlocksFromModel && typeof _win.__kustoGetStatementBlocksFromModel === 'function')
								? _win.__kustoGetStatementBlocksFromModel(model)
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
			} catch (e) { console.error('[kusto]', e); }

			const ACTIVE_STMT_CLASS = 'kusto-active-statement-gutter';
			let activeStmtDecorationIds: any[] = [];
			let cachedBlocks: any = null;
			let cachedVersionId = -1;
			let scheduled = false;

			const computeStatementBlocks = (model: any) => {
				try {
					if (_win.__kustoGetStatementBlocksFromModel && typeof _win.__kustoGetStatementBlocksFromModel === 'function') {
						return _win.__kustoGetStatementBlocksFromModel(model);
					}
				} catch (e) { console.error('[kusto]', e); }
				return [];
			};

			const getBlocksCached = (model: any) => {
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
						if (_win.__kustoIsSeparatorBlankLine && _win.__kustoIsSeparatorBlankLine(model, pos.lineNumber)) {
							activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []);
							return;
						}
					} catch (e) { console.error('[kusto]', e); }

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
					try { activeStmtDecorationIds = editor.deltaDecorations(activeStmtDecorationIds, []); } catch (e) { console.error('[kusto]', e); }
				}
			};

			const scheduleUpdate = () => {
				try {
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(updateActiveStatementIndicator);
				} catch {
					scheduled = false;
					try { setTimeout(updateActiveStatementIndicator, 0); } catch (e) { console.error('[kusto]', e); }
				}
			};

			try {
				editor.onDidChangeCursorPosition(() => scheduleUpdate());
			} catch (e) { console.error('[kusto]', e); }
			try {
				editor.onDidChangeModelContent(() => {
					cachedVersionId = -1;
					scheduleUpdate();
				});
			} catch (e) { console.error('[kusto]', e); }
			try { editor.onDidFocusEditorText(() => scheduleUpdate()); } catch (e) { console.error('[kusto]', e); }
			try { editor.onDidBlurEditorText(() => scheduleUpdate()); } catch (e) { console.error('[kusto]', e); }
			// Initial paint.
			scheduleUpdate();
		} catch (e) { console.error('[kusto]', e); }

		// SEM0139 helper: auto-select term and open Find-with-selection.
		try {
			if (!_win.__kustoAutoFindStateByBoxId || typeof _win.__kustoAutoFindStateByBoxId !== 'object') {
				_win.__kustoAutoFindStateByBoxId = {};
			}
			if (typeof _win.__kustoAutoFindInQueryEditor !== 'function') {
				_win.__kustoAutoFindInQueryEditor = async (boxId: any, term: any) => {
					const bid = String(boxId || '').trim();
					const t = String(term || '');
					if (!bid || !t) return false;
					const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[bid] : null;
					if (!ed) return false;
					try {
						const state = _win.__kustoAutoFindStateByBoxId[bid];
						if (state && state.term === t) {
							return true;
						}
					} catch (e) { console.error('[kusto]', e); }
					const model = (ed && typeof ed.getModel === 'function') ? ed.getModel() : null;
					if (!model || typeof model.findMatches !== 'function') return false;
					let match = null;
					let usedTerm = t;
					const tryFind = (needle: any) => {
						try {
							const s = String(needle || '');
							if (!s) return null;
							const matches = model.findMatches(s, true, false, false, null, true, 1);
							return (matches && matches.length) ? matches[0] : null;
						} catch (e) { console.error('[kusto]', e); }
						return null;
					};

					// Try exact first, then a few safe normalizations for bracket/dynamic access.
					const candidates = (() => {
						const list: any[] = [];
						const push = (s: any) => {
							try {
								const v = String(s || '');
								if (!v) return;
								if (v.length > 400) return;
								if (!list.includes(v)) list.push(v);
							} catch (e) { console.error('[kusto]', e); }
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
						} catch (e) { console.error('[kusto]', e); }

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
					} catch (e) { console.error('[kusto]', e); }
					try {
						const action = ed.getAction && ed.getAction('actions.findWithSelection');
						if (action && typeof action.run === 'function') {
							await action.run();
						} else {
							// Best-effort fallback.
							ed.trigger('keyboard', 'actions.find', {});
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						_win.__kustoAutoFindStateByBoxId[bid] = { term: usedTerm, ts: Date.now() };
					} catch (e) { console.error('[kusto]', e); }
					return true;
				};
			}
			if (typeof _win.__kustoClearAutoFindInQueryEditor !== 'function') {
				_win.__kustoClearAutoFindInQueryEditor = (boxId: any) => {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					let had = false;
					try { had = !!(_win.__kustoAutoFindStateByBoxId && _win.__kustoAutoFindStateByBoxId[bid]); } catch { had = false; }
					if (!had) return;
					try { delete _win.__kustoAutoFindStateByBoxId[bid]; } catch (e) { console.error('[kusto]', e); }
					const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[bid] : null;
					if (!ed) return;
					try {
						// Close find widget if it was opened by us.
						ed.trigger('keyboard', 'closeFindWidget', {});
					} catch (e) { console.error('[kusto]', e); }
					try {
						// Clear selection highlight.
						const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
						if (pos) {
							ed.setSelection({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column });
						}
					} catch (e) { console.error('[kusto]', e); }
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		// Right-click Cut/Copy in Monaco context menu uses Monaco actions (not DOM cut/copy events).
		// Override those actions to use our clipboard workaround when possible.
		try {
			const tryOverride = (actionId: any, isCut: any) => {
				try {
					const action = editor.getAction && editor.getAction(actionId);
					if (!action || typeof action.run !== 'function') {
						return;
					}
					const originalRun = action.run.bind(action);
					action.run = async () => {
						try {
							if (window && typeof _win.__kustoCopyOrCutMonacoEditor === 'function') {
								const ok = await _win.__kustoCopyOrCutMonacoEditor(editor, !!isCut);
								if (ok) {
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							return await originalRun();
						} catch (e) { console.error('[kusto]', e); }
					};
				} catch (e) { console.error('[kusto]', e); }
			};
			tryOverride('editor.action.clipboardCutAction', true);
			tryOverride('editor.action.clipboardCopyAction', false);
		} catch (e) { console.error('[kusto]', e); }

		// Custom right-click context menu with only the actions that work in this webview.
		try {
			const editorDom = editor.getDomNode();
			if (editorDom) {
				editorDom.addEventListener('contextmenu', (e: MouseEvent) => {
					e.preventDefault();
					e.stopPropagation();
					__kustoShowEditorContextMenu(editor, e);
				});
			}
		} catch (e) { console.error('[kusto]', e); }

		_win.queryEditors[boxId] = editor;
		// Allow other scripts to reliably map editor -> boxId (used for global key handlers).
		try { editor.__kustoBoxId = boxId; } catch (e) { console.error('[kusto]', e); }
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try { __kustoEnsureEditorWritableSoon(editor); } catch (e) { console.error('[kusto]', e); }
		try { __kustoInstallWritableGuard(editor); } catch (e) { console.error('[kusto]', e); }
		// Auto-resize this editor to show full content, until the user manually resizes.
		try { __kustoAttachAutoResizeToContent(editor, container); } catch (e) { console.error('[kusto]', e); }

		// F1 should show docs hover (not the webview / VS Code default behavior).
		try {
			editor.addCommand(monaco.KeyCode.F1, () => {
				try {
					editor.trigger('keyboard', 'editor.action.showHover', {});
				} catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Trigger suggest, then auto-hide it if Monaco has nothing to show.
		// NOTE: Be conservative here; hiding too early can suppress real suggestions.
		const __kustoHideSuggestIfNoSuggestions = (ed: any, expectedModelVersionId: any) => {
			try {
				const __kustoSafeEditorTrigger = (editor: any, commandId: any) => {
					try {
						if (!editor || !commandId) return;
						const result = editor.trigger('keyboard', commandId, {});
						// Some Monaco commands return a Promise; avoid unhandled rejections.
						if (result && typeof result.then === 'function') {
							result.catch(() => { /* ignore */ });
						}
					} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }

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
			} catch (e) { console.error('[kusto]', e); }
		};

		// Enhancement (best-effort): when the suggest widget opens and the caret is inside a word,
		// preselect the suggestion that exactly matches the current word (if present).
		// This is intentionally defensive: if Monaco DOM/structure differs, it does nothing.
		const __kustoPreselectExactWordInSuggestIfPresent = (ed: any, expectedModelVersionId: any, forcedWord: any) => {
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
				} catch (e) { console.error('[kusto]', e); }

				let currentWord = '';
				if (typeof forcedWord === 'string' && forcedWord.trim()) {
					currentWord = forcedWord;
				} else {
					currentWord = __kustoGetWordNearCursor(ed);
				}
				if (!currentWord || !String(currentWord).trim()) return;
				const normalize = (s: any) => {
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
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch (e) { console.error('[kusto]', e); }

						const tryGetList = (w0: any) => {
							try {
								const w = (w0 && w0.value) ? w0.value : w0;
								if (!w) return null;
								return w._list || w.list || w._tree || w.tree || null;
							} catch {
								return null;
							}
						};

						const getListLength = (list: any) => {
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
							} catch (e) { console.error('[kusto]', e); }
							return 0;
						};

						const getElementAt = (list: any, idx: any) => {
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
							} catch (e) { console.error('[kusto]', e); }
							return null;
						};

						const getLabelFromElement = (el: any) => {
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
							} catch (e) { console.error('[kusto]', e); }
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
									try { if (typeof list.reveal === 'function') list.reveal(i); } catch (e) { console.error('[kusto]', e); }
									try { if (typeof list.setFocus === 'function') list.setFocus([i]); } catch (e) { console.error('[kusto]', e); }
									try { if (typeof list.setSelection === 'function') list.setSelection([]); } catch (e) { console.error('[kusto]', e); }
									return true;
								}
							}
						}
					} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
							if (!label) {
								try {
									const aria = row.getAttribute ? row.getAttribute('aria-label') : '';
									label = String(aria || '');
								} catch (e) { console.error('[kusto]', e); }
							}
							label = normalize(label);
							if (!label) continue;
							if (String(label).toLowerCase() === targetLower) {
								matchRow = row;
								break;
							}
						}
					}
				} catch (e) { console.error('[kusto]', e); }

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
					} catch (e) { console.error('[kusto]', e); }
					if (!isFinite(idx)) {
						try {
							const ds = matchRow.dataset && (matchRow.dataset.index || matchRow.dataset.row);
							idx = parseInt(String(ds || ''), 10);
						} catch (e) { console.error('[kusto]', e); }
					}

					if (isFinite(idx) && typeof ed.getContribution === 'function') {
						const ctrl = ed.getContribution('editor.contrib.suggestController');
						const candidates = [];
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch (e) { console.error('[kusto]', e); }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch (e) { console.error('[kusto]', e); }
						for (const w0 of candidates) {
							const w1 = (w0 && w0.value) ? w0.value : w0;
							if (!w1) continue;
							const list = w1._list || w1.list || w1._tree || w1.tree;
							if (!list) continue;
							try { if (typeof list.reveal === 'function') list.reveal(idx); } catch (e) { console.error('[kusto]', e); }
							// Only change focus (highlight). Do NOT set selection; some Monaco builds treat
							// selection changes as an accept/commit signal.
								try { if (typeof list.setFocus === 'function') list.setFocus([idx]); } catch (e) { console.error('[kusto]', e); }
								return true;
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				// Fallback: try to focus/select without accepting via gentle hover.
				try {
					const rect = matchRow.getBoundingClientRect ? matchRow.getBoundingClientRect() : null;
					const clientX = rect ? Math.floor(rect.left + Math.min(12, Math.max(2, rect.width / 2))) : 1;
					const clientY = rect ? Math.floor(rect.top + Math.min(8, Math.max(2, rect.height / 2))) : 1;
					const evInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };
					try { matchRow.dispatchEvent(new MouseEvent('mouseover', evInit)); } catch (e) { console.error('[kusto]', e); }
					try { matchRow.dispatchEvent(new MouseEvent('mousemove', evInit)); } catch (e) { console.error('[kusto]', e); }
					try { matchRow.dispatchEvent(new MouseEvent('mouseenter', evInit)); } catch (e) { console.error('[kusto]', e); }
					return true;
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			return false;
		};

		const __kustoTriggerAutocomplete = (ed: any) => {
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
				} catch (e) { console.error('[kusto]', e); }

				let versionId = null;
				try {
					const model = ed.getModel && ed.getModel();
					versionId = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
				} catch (e) { console.error('[kusto]', e); }
				// Record the trigger context so the suggest widget observer can preselect when rows arrive.
				try {
					ed.__kustoLastSuggestTriggerAt = Date.now();
					ed.__kustoLastSuggestTriggerModelVersionId = (typeof versionId === 'number') ? versionId : null;
				} catch (e) { console.error('[kusto]', e); }
				const triggerNow = () => {
					try {
						ed.trigger('keyboard', 'editor.action.triggerSuggest', {});
						try { if (typeof ed.__kustoScheduleSuggestClamp === 'function') ed.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
					} catch (e) { console.error('[kusto]', e); }
				};
				if (shouldDeferTrigger) {
					try {
						requestAnimationFrame(() => {
							try { ed.layout(); } catch (e) { console.error('[kusto]', e); }
							triggerNow();
						});
					} catch {
						setTimeout(() => {
							try { ed.layout(); } catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
		};

		const __kustoMaybeAutoTriggerAutocomplete = (ed: any, boxId: any, changeEvent: any) => {
			try {
				if (!ed) return;
				if (typeof _win.autoTriggerAutocompleteEnabled !== 'boolean' || !_win.autoTriggerAutocompleteEnabled) return;
				// Only auto-trigger for the currently focused query editor.
				try {
					if (typeof _win.activeQueryEditorBoxId === 'string' && _win.activeQueryEditorBoxId !== boxId) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof ed.hasTextFocus === 'function' && !ed.hasTextFocus()) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }

				// Heuristic: trigger for typical typing / completion contexts.
				let shouldTrigger = true;
				let maxChangeLen = 0; // Track longest change to detect autocomplete acceptance vs normal typing
				try {
					shouldTrigger = false;
					const ev = changeEvent && typeof changeEvent === 'object' ? changeEvent : null;
					const changes = ev && Array.isArray(ev.changes) ? ev.changes : null;
					if (!changes || !changes.length) {
						shouldTrigger = true;
					} else {
						for (const ch of changes) {
							const txt = ch && typeof ch.text === 'string' ? ch.text : '';
							if (!txt) {
								continue; // deletion
							}
							maxChangeLen = Math.max(maxChangeLen, txt.length);
							// Newline insertion is a good time to suggest operators/keywords.
							if (txt.indexOf('\n') >= 0 || txt.indexOf('\r') >= 0) {
								shouldTrigger = true;
								break;
							}
							// Typical identifiers / member access / pipe / assignment.
							if (/[A-Za-z0-9_.$|\[\(=]/.test(txt)) {
								shouldTrigger = true;
								break;
							}
							// Space after a pipe is a common moment to suggest operators.
							if (txt === ' ') {
								try {
									const model = ed.getModel && ed.getModel();
									const pos = ed.getPosition && ed.getPosition();
									if (model && pos && typeof model.getLineContent === 'function') {
										const line = model.getLineContent(pos.lineNumber) || '';
										const before = line.slice(0, Math.max(0, pos.column - 1));
										const trimmed = before.replace(/\s+$/, '');
										if (trimmed.endsWith('|')) {
											shouldTrigger = true;
											break;
										}
									}
								} catch (e) { console.error('[kusto]', e); }
							}
						}
					}
				} catch {
					shouldTrigger = true;
				}
				if (!shouldTrigger) return;

				// Debounce + rate-limit (typing can fire rapidly).
				try {
					if (ed.__kustoAutoSuggestTimer) {
						clearTimeout(ed.__kustoAutoSuggestTimer);
					}
				} catch (e) { console.error('[kusto]', e); }

				const changeLen = maxChangeLen; // Capture for closure
				ed.__kustoAutoSuggestTimer = setTimeout(() => {
					try {
						const now = Date.now();
						const last = (typeof ed.__kustoAutoSuggestLastTriggeredAt === 'number') ? ed.__kustoAutoSuggestLastTriggeredAt : 0;
						if (now - last < 180) return;

						// Never auto-trigger when cursor is at the end of a completed term.
						// E.g.: `| where ColumnName > ColumnName2<cursor>` or `dcount(ClientName<cursor>)`
						// - there's nothing useful to suggest here. The user needs to type more first.
						try {
							const model = ed.getModel && ed.getModel();
							const pos = ed.getPosition && ed.getPosition();
							if (model && pos && typeof model.getLineContent === 'function') {
								const line = model.getLineContent(pos.lineNumber) || '';
								const col = pos.column; // 1-based
								const charBeforeCursor = col > 1 ? line[col - 2] : ''; // col-2 because col is 1-based
								const charAtCursor = col <= line.length ? line[col - 1] : ''; // char at cursor position (or empty if at EOL)

								const isWordChar = (c: any) => /[A-Za-z0-9_]/.test(c || '');

								// If cursor is right after a word character and NOT followed by another word character,
								// we're at the end of a completed term - skip triggering.
								// This covers: EOL, whitespace, ), ], }, comma, operators, etc.
								if (isWordChar(charBeforeCursor) && !isWordChar(charAtCursor)) {
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }

						ed.__kustoAutoSuggestLastTriggeredAt = now;
						__kustoTriggerAutocomplete(ed);
					} catch (e) { console.error('[kusto]', e); }
				}, 140);
			} catch (e) { console.error('[kusto]', e); }
		};

		// Expose the preselect helper so the suggest widget sizing/visibility observer can call it.
		try {
			editor.__kustoPreselectExactWordInSuggestIfPresent = (forcedWord: any) => {
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
					} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }

		// Expose for toolbar / other scripts.
		try {
			if (typeof _win.__kustoTriggerAutocompleteForBoxId !== 'function') {
				_win.__kustoTriggerAutocompleteForBoxId = (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
						if (ed) {
							__kustoTriggerAutocomplete(ed);
						}
					} catch (e) { console.error('[kusto]', e); }
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		const __kustoReplaceAllText = (ed: any, nextText: any, label: any) => {
			try {
				if (!ed) return;
				const model = ed.getModel && ed.getModel();
				if (!model) return;
				const current = model.getValue();
				if (current === nextText) return;
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch (e) { console.error('[kusto]', e); }
				const full = model.getFullModelRange ? model.getFullModelRange() : null;
				if (!full) {
					model.setValue(nextText);
					return;
				}
				ed.executeEdits(label || 'kusto-format', [{ range: full, text: nextText }]);
				try { ed.pushUndoStop && ed.pushUndoStop(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		// Expose query formatting helpers for toolbar buttons.
		try {
			if (typeof _win.__kustoSingleLineQueryForBoxId !== 'function') {
				_win.__kustoSingleLineQueryForBoxId = (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoToSingleLineKusto(v);
						__kustoReplaceAllText(ed, next, 'kusto-single-line');
					} catch (e) { console.error('[kusto]', e); }
				};
			}
			if (typeof _win.__kustoPrettifyQueryForBoxId !== 'function') {
				_win.__kustoPrettifyQueryForBoxId = (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoPrettifyKustoTextWithSemicolonStatements(v);
						__kustoReplaceAllText(ed, next, 'kusto-prettify');
					} catch (e) { console.error('[kusto]', e); }
				};
			}
			if (typeof _win.__kustoPrettifyKustoText !== 'function') {
				_win.__kustoPrettifyKustoText = (text: any) => {
					try {
						return __kustoPrettifyKustoTextWithSemicolonStatements(String(text ?? ''));
					} catch {
						return String(text ?? '');
					}
				};
			}
			if (typeof _win.__kustoCopySingleLineQueryForBoxId !== 'function') {
				_win.__kustoCopySingleLineQueryForBoxId = async (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
						if (!ed) return;
						let v = ed.getValue ? ed.getValue() : '';
						// When the editor has multiple statements, operate on the statement under the cursor.
						try {
							const model = ed.getModel && ed.getModel();
							const blocks = (model && typeof _win.__kustoGetStatementBlocksFromModel === 'function')
								? _win.__kustoGetStatementBlocksFromModel(model)
								: [];
							const hasMultipleStatements = blocks && blocks.length > 1;
							if (hasMultipleStatements && typeof _win.__kustoExtractStatementTextAtCursor === 'function') {
								const stmt = _win.__kustoExtractStatementTextAtCursor(ed);
								if (stmt) {
									v = stmt;
								} else {
									try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to copy that statement as a single line.' }); } catch (e) { console.error('[kusto]', e); }
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						const single = __kustoToSingleLineKusto(v);

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(single);
								try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						} catch (e) { console.error('[kusto]', e); }

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
						try { ta.parentNode && ta.parentNode.removeChild(ta); } catch (e) { console.error('[kusto]', e); }
						if (!ok) {
							throw new Error('copy failed');
						}
						try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					} catch {
						try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Failed to copy single-line query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					}
				};
			}
		} catch (e) { console.error('[kusto]', e); }

		// Ensure Ctrl+Space always triggers autocomplete inside the webview.
		try {
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
				__kustoTriggerAutocomplete(editor);
			});
		} catch (e) { console.error('[kusto]', e); }

		// Shift+Space triggers Copilot inline suggestions (ghost text) on demand.
		try {
			editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Space, () => {
				console.log('[Kusto] SHIFT+SPACE triggered - requesting inline suggestions');
				editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Enter / Ctrl+Shift+Enter should execute the query (same as the Run button).
		// NOTE: We install this at the Monaco level so Monaco can't consume Ctrl+Shift+Enter before
		// our document-level capture handler runs.
		try {
			const __kustoRunThisQueryBox = () => {
				try {
					_win.executeQuery(boxId);
				} catch (e) { console.error('[kusto]', e); }
			};
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, __kustoRunThisQueryBox);
		} catch (e) { console.error('[kusto]', e); }

		// Docs tooltip: keep visible while typing, even when Monaco autocomplete is open.
		const renderDocMarkdownToHtml = (markdown: any) => {
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
			} catch (e) { console.error('[kusto]', e); }
			const escaped = typeof _win.escapeHtml === 'function' ? _win.escapeHtml(raw) : raw;
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
				if (!_win.__kustoCaretDocsLastHtmlByBoxId || typeof _win.__kustoCaretDocsLastHtmlByBoxId !== 'object') {
					_win.__kustoCaretDocsLastHtmlByBoxId = {};
				}
				const cached = _win.__kustoCaretDocsLastHtmlByBoxId[boxId];
				if (typeof cached === 'string' && cached.trim()) {
					lastDocsHtml = cached;
					lastHtml = cached;
					// If caret-docs are enabled, paint the cached docs immediately so we don't flash watermark.
					try {
						if (typeof _win.caretDocsEnabled === 'undefined' || _win.caretDocsEnabled !== false) {
							if (banner) banner.style.display = 'flex';
							if (text) {
								if (text.classList) text.classList.remove('is-watermark');
								text.innerHTML = cached;
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			// In VS Code webviews, document.hasFocus() can be unreliable when the VS Code window
			// loses focus. Track focus explicitly from window-level events.
			try {
				if (typeof _win.__kustoWebviewHasFocus !== 'boolean') {
					_win.__kustoWebviewHasFocus = true;
				}
				if (!_win.__kustoWebviewFocusListenersInstalled) {
					_win.__kustoWebviewFocusListenersInstalled = true;
					try {
						window.addEventListener(
							'blur',
							() => {
								try { _win.__kustoWebviewHasFocus = false; } catch (e) { console.error('[kusto]', e); }
								// After focus flips, refresh the active overlay once so it can freeze/restore docs.
								try {
									setTimeout(() => {
										try {
											if (typeof _win.__kustoRefreshActiveCaretDocs === 'function') {
												_win.__kustoRefreshActiveCaretDocs();
											}
										} catch (e) { console.error('[kusto]', e); }
									}, 0);
								} catch (e) { console.error('[kusto]', e); }
							},
							true
						);
					} catch (e) { console.error('[kusto]', e); }
					try { window.addEventListener('focus', () => { try { _win.__kustoWebviewHasFocus = true; } catch (e) { console.error('[kusto]', e); } }, true); } catch (e) { console.error('[kusto]', e); }
					try {
						document.addEventListener('visibilitychange', () => {
							try {
								// When the tab becomes hidden, treat as unfocused.
								_win.__kustoWebviewHasFocus = !document.hidden;
							} catch (e) { console.error('[kusto]', e); }
						}, true);
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			const isWebviewFocused = () => {
				try {
					if (typeof _win.__kustoWebviewHasFocus === 'boolean') {
						return !!_win.__kustoWebviewHasFocus;
					}
				} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (banner) {
						banner.style.display = 'flex';
					}
				} catch (e) { console.error('[kusto]', e); }
				try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }
				lastHtml = '';
				lastKey = 'watermark';
			};

			const hide = () => {
				try {
					if (banner) banner.style.display = 'none';
				} catch (e) { console.error('[kusto]', e); }
				try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
			};

			const update = () => {
				try {
					// Default to enabled if the global toggle hasn't been initialized yet.
					try {
						if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
							hide();
							return;
						}
					} catch (e) { console.error('[kusto]', e); }

						// When the editor is not focused, freeze the banner content.
						// This avoids resetting to the watermark while focus is elsewhere.
						try {
							let hasFocus = false;
							try {
								// If the overall VS Code/webview is unfocused, freeze regardless of Monaco state.
								try {
									if (typeof _win.__kustoWebviewHasFocus === 'boolean' && _win.__kustoWebviewHasFocus === false) {
										hasFocus = false;
										throw new Error('webview not focused');
									}
								} catch (e) { console.error('[kusto]', e); }

								// If the VS Code window/webview isn't focused, freeze regardless of Monaco internals.
								try {
									if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
										hasFocus = false;
										throw new Error('document not focused');
									}
								} catch (e) { console.error('[kusto]', e); }

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
							} catch (e) { console.error('[kusto]', e); }
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
								} catch (e) { console.error('[kusto]', e); }
								try {
									if (banner) banner.style.display = 'flex';
								} catch (e) { console.error('[kusto]', e); }
								try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
								return;
							}
						} catch (e) { console.error('[kusto]', e); }

					// Prefer the explicit "active editor" tracking. In some Monaco builds,
					// hasTextFocus/hasWidgetFocus can be unreliable while the suggest widget is open.
					try {
						const activeId = (typeof _win.activeQueryEditorBoxId !== 'undefined' && _win.activeQueryEditorBoxId)
							? String(_win.activeQueryEditorBoxId)
							: null;
						if (activeId && activeId !== String(boxId)) {
								// When another editor is active, keep the last content (if any) instead
								// of resetting to the watermark.
								if (!lastHtml) {
									showWatermark();
								} else {
									try { if (banner) banner.style.display = 'flex'; } catch (e) { console.error('[kusto]', e); }
									try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
								}
								return;
						}
					} catch (e) { console.error('[kusto]', e); }

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
									} catch (e) { console.error('[kusto]', e); }
									try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
									return;
								}
								showWatermark();
								return;
							}

					const getter = _win.__kustoGetHoverInfoAt;
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
					} catch (e) { console.error('[kusto]', e); }
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
								} catch (e) { console.error('[kusto]', e); }
								break;
							}
						} catch (e) { console.error('[kusto]', e); }
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
									if (_win.__kustoCaretDocsLastHtmlByBoxId && typeof _win.__kustoCaretDocsLastHtmlByBoxId === 'object') {
										_win.__kustoCaretDocsLastHtmlByBoxId[boxId] = html;
									}
								} catch (e) { console.error('[kusto]', e); }
						try {
							if (text) {
								if (text.classList) {
									text.classList.remove('is-watermark');
								}
								text.innerHTML = html;
							}
						} catch (e) { console.error('[kusto]', e); }
					}
					if (key !== lastKey) {
						lastKey = key;
					}

					try {
						if (banner) banner.style.display = 'flex';
					} catch (e) { console.error('[kusto]', e); }
					try { updatePlaceholderPosition(); } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
			};

			return { update, hide, showWatermark };
		};

					const docOverlay = createDocOverlay();
					try {
						if (typeof _win.caretDocOverlaysByBoxId !== 'undefined' && _win.caretDocOverlaysByBoxId) {
							_win.caretDocOverlaysByBoxId[boxId] = docOverlay;
						}
					} catch (e) { console.error('[kusto]', e); }

					// Keep the overlay positioned correctly when the outer webview scrolls/resizes.
					// Install once globally to avoid accumulating listeners per editor.
					try {
						if (!_win.__kustoCaretDocsViewportListenersInstalled) {
							_win.__kustoCaretDocsViewportListenersInstalled = true;
							const refreshActive = () => {
								try {
									if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
										return;
									}
									const overlays = typeof _win.caretDocOverlaysByBoxId !== 'undefined' ? _win.caretDocOverlaysByBoxId : null;
									if (!overlays) {
										return;
									}
									let activeId = null;
									try {
										activeId = typeof _win.activeQueryEditorBoxId !== 'undefined' ? _win.activeQueryEditorBoxId : null;
									} catch {
										activeId = null;
									}
									if (activeId && overlays[activeId] && typeof overlays[activeId].update === 'function') {
										overlays[activeId].update();
									}
								} catch (e) { console.error('[kusto]', e); }
							};
								try {
									// Allow other features (e.g., async doc fetch) to request a re-render of the active caret-docs banner.
									_win.__kustoRefreshActiveCaretDocs = refreshActive;
								} catch (e) { console.error('[kusto]', e); }
							window.addEventListener('scroll', refreshActive, true);
							window.addEventListener('resize', refreshActive);
						}
					} catch (e) { console.error('[kusto]', e); }

		// Hide caret tooltip on Escape (without preventing Monaco default behavior).
		try {
			editor.onKeyDown((e: any) => {
				try {
					if (!e) return;
					// monaco.KeyCode.Escape === 9
					if (e.keyCode === monaco.KeyCode.Escape) {
						try {
							if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
								docOverlay.hide();
							} else if (docOverlay && typeof docOverlay.showWatermark === 'function') {
								docOverlay.showWatermark();
							}
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }
		let docTimer: any = null;
		const scheduleDocUpdate = () => {
			try {
				if (docTimer) {
					clearTimeout(docTimer);
				}
				docTimer = setTimeout(() => {
					try { docOverlay.update(); } catch (e) { console.error('[kusto]', e); }
				}, 140);
			} catch (e) { console.error('[kusto]', e); }
		};

		editor.onDidChangeCursorPosition(scheduleDocUpdate);
		try { editor.onDidScrollChange(scheduleDocUpdate); } catch (e) { console.error('[kusto]', e); }
		try {
			const model = editor.getModel();
			if (model && model.uri) {
				_win.queryEditorBoxByModelUri[model.uri.toString()] = boxId;
			}
		} catch (e) { console.error('[kusto]', e); }

		const syncPlaceholder = () => {
			if (!placeholder) {
				return;
			}
			updatePlaceholderPosition();
			// Hide placeholder while the editor is focused, even if empty.
			const isFocused = _win.activeQueryEditorBoxId === boxId;
			placeholder.style.display = (!editor.getValue().trim() && !isFocused) ? 'block' : 'none';
		};
		syncPlaceholder();
		editor.onDidChangeModelContent((e: any) => {
			syncPlaceholder();
			scheduleDocUpdate();
			try {
				if (typeof _win.__kustoOnQueryValueChanged === 'function') {
					_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoScheduleKustoDiagnostics === 'function') {
					_win.__kustoScheduleKustoDiagnostics(boxId, 250);
				}
			} catch (e) { console.error('[kusto]', e); }
			try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references and request their schemas
			try {
				if (typeof _win.__kustoCheckCrossClusterRefs === 'function') {
					// Debounce the check to avoid excessive requests while typing
					if (!_win.__kustoCrossClusterCheckTimeout) {
						_win.__kustoCrossClusterCheckTimeout = {};
					}
					clearTimeout(_win.__kustoCrossClusterCheckTimeout[boxId]);
					_win.__kustoCrossClusterCheckTimeout[boxId] = setTimeout(() => {
						_win.__kustoCheckCrossClusterRefs(editor.getValue(), boxId);
					}, 500);
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoTriggerAutocomplete(editor, boxId, e); } catch (e) { console.error('[kusto]', e); }
		});
		editor.onDidFocusEditorText(() => {
			_win.activeQueryEditorBoxId = boxId;
			try { _win.activeQueryEditorBoxId = boxId; } catch (e) { console.error('[kusto]', e); }
			try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
			try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
			try { _win.__kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
			try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			syncPlaceholder();
			_win.ensureSchemaForBox(boxId);
			scheduleDocUpdate();
			// Update monaco-kusto schema if switching to a different cluster/database
			try {
				if (typeof _win.__kustoUpdateSchemaForFocusedBox === 'function') {
					_win.__kustoUpdateSchemaForFocusedBox(boxId);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof _win.__kustoScheduleKustoDiagnostics === 'function') {
					_win.__kustoScheduleKustoDiagnostics(boxId, 0);
				}
			} catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references on focus (in addition to content change)
			try {
				if (typeof _win.__kustoCheckCrossClusterRefs === 'function') {
					// Small delay to let the schema load first
					setTimeout(() => {
						_win.__kustoCheckCrossClusterRefs(editor.getValue(), boxId);
					}, 100);
				}
			} catch (e) { console.error('[kusto]', e); }
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				_win.activeQueryEditorBoxId = boxId;
				try { _win.activeQueryEditorBoxId = boxId; } catch (e) { console.error('[kusto]', e); }
				try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
				try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
				try { _win.__kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
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
								if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
									docOverlay.hide();
								}
							} catch (e) { console.error('[kusto]', e); }
							if (_win.activeQueryEditorBoxId === boxId) {
								_win.activeQueryEditorBoxId = null;
								try { _win.activeQueryEditorBoxId = null; } catch (e) { console.error('[kusto]', e); }
							}
							syncPlaceholder();
							// Keep existing docs banner content visible while unfocused.
							// (The overlay's update loop also freezes while unfocused.)
							
							// Disable markers (red squiggles) for this editor now that it's unfocused
							try {
								const model = editor.getModel();
								if (model && model.uri && typeof _win.__kustoDisableMarkersForModel === 'function') {
									_win.__kustoDisableMarkersForModel(model.uri);
								}
							} catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			});
		} catch (e) { console.error('[kusto]', e); }

		// In VS Code webviews, the first click can sometimes focus the webview but not reliably
		// place the Monaco caret if we eagerly call editor.focus() during the same mouse event.
		// Defer focus slightly so Monaco can handle click-to-place-caret on the first click.
		const focusSoon = () => {
			setTimeout(() => {
				try { _win.activeQueryEditorBoxId = boxId; } catch (e) { console.error('[kusto]', e); }
				try { _win.activeMonacoEditor = editor; } catch (e) { console.error('[kusto]', e); }
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
				try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
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
					if (e && e.target && (e.target as HTMLElement).closest) {
						// Allow embedded UI (e.g. Copilot Chat) to receive focus.
						if ((e.target as HTMLElement).closest('.kusto-copilot-chat') || (e.target as HTMLElement).closest('[data-kusto-no-editor-focus="true"]')) {
							return;
						}
						if ((e.target as HTMLElement).closest('.query-editor-toolbar')) {
							return;
						}
						if ((e.target as HTMLElement).closest('.query-editor-resizer')) {
							return;
						}
						// Allow Monaco widgets (find widget, suggest widget, etc.) to receive focus.
						if ((e.target as HTMLElement).closest('.find-widget') || (e.target as HTMLElement).closest('.suggest-widget') || (e.target as HTMLElement).closest('.parameter-hints-widget') || (e.target as HTMLElement).closest('.monaco-hover') || (e.target as HTMLElement).closest('.overflowingContentWidgets')) {
							return;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
				focusSoon();
			}, true);
		}

		// Keep a direct hook on the editor container too.
		container.addEventListener('mousedown', (e) => {
			try {
				if (e && e.target && (e.target as HTMLElement).closest) {
					// Allow Monaco widgets (find widget, suggest widget, etc.) to receive focus.
					if ((e.target as HTMLElement).closest('.find-widget') || (e.target as HTMLElement).closest('.suggest-widget') || (e.target as HTMLElement).closest('.parameter-hints-widget') || (e.target as HTMLElement).closest('.monaco-hover') || (e.target as HTMLElement).closest('.overflowingContentWidgets')) {
						return;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			focusSoon();
		}, true);
		editor.onDidBlurEditorText(() => {
			syncPlaceholder();
		});

		// Ensure Monaco has a correct initial layout after insertion into the DOM.
		try {
			requestAnimationFrame(() => {
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
			});
		} catch (e) { console.error('[kusto]', e); }

		// Kick off missing-cluster detection for the initial value as well.
		try {
			if (typeof _win.__kustoOnQueryValueChanged === 'function') {
				_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
			}
		} catch (e) { console.error('[kusto]', e); }

		// Note: we intentionally do NOT auto-trigger Monaco suggestions on typing.
		// Users can trigger via Ctrl+Space or the toolbar button.

		// Keep Monaco laid out when the user resizes the wrapper.
		if (wrapper && typeof ResizeObserver !== 'undefined') {
			if (_win.queryEditorResizeObservers[boxId]) {
				try { _win.queryEditorResizeObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			}
			const ro = new ResizeObserver(() => {
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
			});
			ro.observe(wrapper);
			_win.queryEditorResizeObservers[boxId] = ro;
		}

		// In multi-editor layouts (e.g. Copilot split panes), editors can be created while hidden.
		// Ensure we relayout when the wrapper becomes visible again so Monaco widgets position correctly.
		try {
			if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers && _win.queryEditorVisibilityObservers[boxId]) {
				try { _win.queryEditorVisibilityObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete _win.queryEditorVisibilityObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers && _win.queryEditorVisibilityMutationObservers[boxId]) {
				try { _win.queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete _win.queryEditorVisibilityMutationObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		const scheduleRelayoutSoon = () => {
			try {
				requestAnimationFrame(() => {
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
				});
			} catch {
				setTimeout(() => {
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
					try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
				});
				io.observe(observedEl);
				try { if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers) _win.queryEditorVisibilityObservers[boxId] = io; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		try {
			if (wrapper && typeof MutationObserver !== 'undefined') {
				const mo = new MutationObserver(() => {
					try {
						// Only relayout if the wrapper is measurable (visible).
						const h = wrapper.getBoundingClientRect ? Math.round(wrapper.getBoundingClientRect().height || 0) : 0;
						if (h > 0) {
							scheduleRelayoutSoon();
						}
					} catch (e) { console.error('[kusto]', e); }
				});
				mo.observe(wrapper, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
				try { if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers) _win.queryEditorVisibilityMutationObservers[boxId] = mo; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Initialize toolbar overflow handling (shows "..." button when buttons overflow)
		try {
			if (typeof _win.initToolbarOverflow === 'function') {
				_win.initToolbarOverflow(boxId);
			}
		} catch (e) { console.error('[kusto]', e); }

		// Drag handle resize (more reliable than CSS resize in VS Code webviews).
		if (resizer) {
			const resolveWrapperForResize = () => {
				try {
					let w = null;
					try {
						w = (resizer && resizer.closest) ? resizer.closest('.query-editor-wrapper') : null;
					} catch (e) { console.error('[kusto]', e); }
					if (!w) {
						try {
							w = (container && container.closest) ? container.closest('.query-editor-wrapper') : null;
						} catch (e) { console.error('[kusto]', e); }
					}
					if (!w) {
						try {
							const box = document.getElementById(boxId);
							w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
						} catch (e) { console.error('[kusto]', e); }
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
					(w as any).dataset.kustoUserResized = 'true';
					try { delete (w as any).dataset.kustoAutoResized; } catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				try {
					if (!_win.__kustoManualQueryEditorHeightPxByBoxId || typeof _win.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
						_win.__kustoManualQueryEditorHeightPxByBoxId = {};
					}
				} catch (e) { console.error('[kusto]', e); }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
				const startHeight = w.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
							_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch (e) { console.error('[kusto]', e); }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					// Use a larger min-height when the Copilot chat is visible.
					let minHeightPx = 120;
					try {
						const split = w.querySelector('.kusto-copilot-split');
						if (split && !split.classList.contains('kusto-copilot-chat-hidden')) {
							minHeightPx = 180;
						}
					} catch (e) { console.error('[kusto]', e); }
					// Manual resizing should not have a max height cap.
					const nextHeight = Math.max(minHeightPx, startHeight + delta);
					(w as any).style.height = nextHeight + 'px';
					try {
						if (_win.__kustoManualQueryEditorHeightPxByBoxId && typeof _win.__kustoManualQueryEditorHeightPxByBoxId === 'object') {
							_win.__kustoManualQueryEditorHeightPxByBoxId[boxId] = Math.round(nextHeight);
						}
					} catch (e) { console.error('[kusto]', e); }
					try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click to fit editor to contents - delegate to the button's function
			// which already handles measurement with proper retries for async layout settling.
			resizer.addEventListener('dblclick', (e) => {
				try {
					e.preventDefault();
					e.stopPropagation();
					if (typeof _win.__kustoAutoSizeEditor === 'function') {
						_win.__kustoAutoSizeEditor(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
			});
		}
	}).catch((e: any) => {
		// If Monaco fails to initialize transiently, retry a few times so the editor
		// doesn't get stuck in a non-interactive placeholder state until reopen.
		try {
			if (_win.queryEditors && _win.queryEditors[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		let attempt = 0;
		try {
			_win.__kustoMonacoInitRetryCountByBoxId = _win.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (_win.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			_win.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (query editor).', e); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		try {
			setTimeout(() => {
				try { initQueryEditor(boxId); } catch (e) { console.error('[kusto]', e); }
			}, delay);
		} catch (e) { console.error('[kusto]', e); }
	});
}

// ── Custom context menu for Monaco editors ──
// Monaco's built-in context menu is disabled (contextmenu: false) because most of its items
// (Go to Definition, Rename, Format, etc.) have no providers in this webview.
// This custom menu provides the clipboard and selection actions that actually work.

let __kustoEditorContextMenuEl: HTMLElement | null = null;
let __kustoEditorContextMenuCleanup: (() => void) | null = null;

function __kustoHideEditorContextMenu() {
	try {
		if (__kustoEditorContextMenuCleanup) {
			__kustoEditorContextMenuCleanup();
			__kustoEditorContextMenuCleanup = null;
		}
		if (__kustoEditorContextMenuEl) {
			__kustoEditorContextMenuEl.remove();
			__kustoEditorContextMenuEl = null;
		}
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoShowEditorContextMenu(editor: any, event: MouseEvent) {
	__kustoHideEditorContextMenu();
	// Also hide any results-table context menu that might be open.
	try { if (typeof _win.__kustoHideContextMenu === 'function') _win.__kustoHideContextMenu(); } catch (e) { /* ignore */ }

	const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
	const mod = isMac ? '\u2318' : 'Ctrl';

	const hasSelection = (() => {
		try {
			const sel = editor.getSelection();
			return sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn);
		} catch { return false; }
	})();

	const isReadOnly = (() => {
		try {
			const opts = editor.getOptions();
			// readOnly option id is 90 in monaco 0.52; fall back to getRawOptions
			try {
				const raw = editor.getRawOptions();
				return !!raw.readOnly;
			} catch { return false; }
		} catch { return false; }
	})();

	type MenuItem = { label: string; shortcut: string; action: () => void; disabled?: boolean } | { separator: true };
	const items: MenuItem[] = [];

	if (!isReadOnly) {
		items.push({ label: 'Cut', shortcut: `${mod}+X`, action: () => { _win.__kustoCopyOrCutMonacoEditor?.(editor, true); }, disabled: !hasSelection });
	}
	items.push({ label: 'Copy', shortcut: `${mod}+C`, action: () => { _win.__kustoCopyOrCutMonacoEditor?.(editor, false); }, disabled: !hasSelection });
	if (!isReadOnly) {
		items.push({
			label: 'Paste', shortcut: `${mod}+V`, action: async () => {
				try {
					const text = await navigator.clipboard.readText();
					if (typeof text === 'string') {
						const selection = editor.getSelection();
						if (selection) {
							editor.executeEdits('clipboard', [{ range: selection, text }]);
							editor.focus();
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		});
	}
	if (!isReadOnly) {
		items.push({ separator: true });
		items.push({ label: 'Undo', shortcut: `${mod}+Z`, action: () => { try { editor.trigger('contextMenu', 'undo', null); } catch (e) { console.error('[kusto]', e); } } });
		items.push({ label: 'Redo', shortcut: `${mod}+Y`, action: () => { try { editor.trigger('contextMenu', 'redo', null); } catch (e) { console.error('[kusto]', e); } } });
	}
	items.push({ separator: true });
	if (!isReadOnly) {
		items.push({ label: 'Toggle Comment', shortcut: `${mod}+/`, action: () => { try { editor.trigger('contextMenu', 'editor.action.commentLine', null); } catch (e) { console.error('[kusto]', e); } } });
	}
	items.push({ label: 'Select All', shortcut: `${mod}+A`, action: () => { try { editor.trigger('contextMenu', 'editor.action.selectAll', null); } catch (e) { console.error('[kusto]', e); } } });

	const menu = document.createElement('div');
	menu.className = 'kusto-context-menu';
	menu.setAttribute('role', 'menu');

	for (const item of items) {
		if ('separator' in item) {
			const sep = document.createElement('div');
			sep.className = 'kusto-context-menu-separator';
			menu.appendChild(sep);
			continue;
		}
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'kusto-context-menu-item';
		btn.setAttribute('role', 'menuitem');
		if (item.disabled) {
			btn.disabled = true;
			btn.classList.add('disabled');
		}

		const labelSpan = document.createElement('span');
		labelSpan.textContent = item.label;
		btn.appendChild(labelSpan);

		const shortcutSpan = document.createElement('span');
		shortcutSpan.className = 'kusto-context-menu-shortcut';
		shortcutSpan.textContent = item.shortcut;
		btn.appendChild(shortcutSpan);

		const action = item.action;
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			__kustoHideEditorContextMenu();
			action();
		});
		menu.appendChild(btn);
	}

	document.body.appendChild(menu);
	__kustoEditorContextMenuEl = menu;

	// Position: use event coordinates, but clamp to viewport.
	const menuRect = menu.getBoundingClientRect();
	let left = event.pageX;
	let top = event.pageY;
	if (left + menuRect.width > window.innerWidth) {
		left = Math.max(0, window.innerWidth - menuRect.width - 4);
	}
	if (top + menuRect.height > window.innerHeight) {
		top = Math.max(0, window.innerHeight - menuRect.height - 4);
	}
	menu.style.left = left + 'px';
	menu.style.top = top + 'px';

	// Dismiss on outside click or scroll.
	const onDismiss = (e: Event) => {
		try {
			if (menu.contains(e.target as Node)) return;
			__kustoHideEditorContextMenu();
		} catch { __kustoHideEditorContextMenu(); }
	};
	const onScroll = () => { __kustoHideEditorContextMenu(); };
	const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') __kustoHideEditorContextMenu(); };

	setTimeout(() => {
		document.addEventListener('mousedown', onDismiss, true);
		window.addEventListener('scroll', onScroll, { capture: true, passive: true });
		document.addEventListener('keydown', onKeyDown, true);
	}, 0);

	__kustoEditorContextMenuCleanup = () => {
		document.removeEventListener('mousedown', onDismiss, true);
		window.removeEventListener('scroll', onScroll, true);
		document.removeEventListener('keydown', onKeyDown, true);
	};
}

// ── Window bridges for remaining legacy callers ──
window.__kustoGetColumnsByTable = __kustoGetColumnsByTable;
window.ensureMonaco = ensureMonaco;
window.initQueryEditor = initQueryEditor;
