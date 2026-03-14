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

const _win = window as unknown as Record<string, any>;

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
									setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 30000);
									return worker;
								}
								// Fall back to standard editor worker if kusto worker not available
								return new Worker(cfg.monacoEditorWorkerUri);
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
								setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 30000);
								return worker;
							}
						};
					}
				} catch {
					// ignore
				}

				try {
					(req as any).config({ paths: { vs: _win.__kustoQueryEditorConfig.monacoVsUri } });
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
									} catch (e) {
										// Failed to clear markers, non-critical
									}
								};
							} catch (e) {
								// Failed to install setModelMarkers interception
							}

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
								} catch { /* ignore */ }

								KUSTO_FUNCTION_DOCS[fnKey] = {
									args,
									returnType: 'scalar',
									description,
									signature,
									docUrl
								};
							}
						} catch {
							// ignore
						}
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
							} catch { /* ignore */ }
						} catch {
							// ignore
						}
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

					const __kustoTryGetDotCommandCompletionContext = (model: any, position: any, statementStartInCursorText: any, statementTextUpToCursor: any) => {
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

					const __kustoGetControlCommandHoverAt = (model: any, position: any) => {
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
										.map((a: any, i: any) => (i === active ? `**${a}**=` : `${a}=`))
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
						try { __kustoEnsureGeneratedFunctionsMerged(); } catch { /* ignore */ }
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
					let __kustoProvideCompletionItemsForDiagnostics = null;
					const __kustoCompletionProvider = {
						triggerCharacters: [' ', '|', '.'],
						provideCompletionItems: async function (model: any, position: any) {
							// Generated Kusto function names (from Microsoft Learn TOC) are loaded by `queryEditor/functions.generated.js`.
							// Merge those into our hand-authored docs so completions are comprehensive even when we don't
							// have detailed arg/return docs for every function.
							try {
								if (typeof window !== 'undefined' && window) {
									if (!_win.__kustoGeneratedFunctionsMerged) {
										_win.__kustoGeneratedFunctionsMerged = true;
										const raw = Array.isArray(_win.__kustoFunctionEntries) ? _win.__kustoFunctionEntries : [];
										const docs = (_win.__kustoFunctionDocs && typeof _win.__kustoFunctionDocs === 'object') ? _win.__kustoFunctionDocs : null;
										for (const ent of raw) {
											const name = Array.isArray(ent) ? ent[0] : (ent && ent.name);
											if (!name) continue;
											const fn = String(name).trim();
											if (!fn) continue;
											if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn)) continue;
											if (KUSTO_FUNCTION_DOCS[fn]) continue;

											const g = (docs && docs[fn] && typeof docs[fn] === 'object') ? docs[fn] : null;
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
											} catch { /* ignore */ }

											KUSTO_FUNCTION_DOCS[fn] = {
												args,
												returnType: 'scalar',
												description,
												signature,
												docUrl
											};
										}
									}
								}
							} catch {
								// ignore
							}
							const suggestions: any[] = [];
							const seen = new Set();

							const pushSuggestion = (item: any, key: any) => {
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
									boxId = _win.queryEditorBoxByModelUri[model.uri.toString()] || null;
								}
							} catch {
								// ignore
							}
							if (!boxId) {
								boxId = _win.activeQueryEditorBoxId;
							}
							const schema = boxId ? _win.schemaByBoxId[boxId] : null;
							if (!schema || !schema.tables) {
								// Kick off a background fetch if schema isn't ready yet (but still return operator suggestions).
								_win.ensureSchemaForBox(boxId);

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
									const __kustoBuildFnInsertText = (fnName: any, fnDoc: any) => {
										const args = (fnDoc && Array.isArray(fnDoc.args)) ? fnDoc.args : [];
										const required = args.filter((a: any) => typeof a === 'string' && !a.endsWith('?'));
										if (required.length === 0) {
											return { insertText: fnName + '()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
										}
										const snippetArgs = required.map((a: any, i: any) => '${' + (i + 1) + ':' + a + '}').join(', ');
										return { insertText: fnName + '(' + snippetArgs + ')', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
									};
									for (const fn of Object.keys(KUSTO_FUNCTION_DOCS)) {
										if (typed && !fn.toLowerCase().startsWith(typed)) {
											continue;
										}
											const doc = KUSTO_FUNCTION_DOCS[fn];
											const detail = doc && (doc.signature || doc.returnType) ? String(doc.signature || doc.returnType) : undefined;
											const documentation = (() => {
												try {
													const desc = doc && doc.description ? String(doc.description) : '';
													const url = doc && doc.docUrl ? String(doc.docUrl) : '';
													if (!desc && !url) return undefined;
													if (url) {
														return { value: desc ? (desc + `\n\n[Open documentation](${url})`) : `[Open documentation](${url})` };
													}
													return { value: desc };
												} catch {
													return undefined;
												}
											})();
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

							const __kustoNormalizeClusterForKusto = (clusterUrl: any) => {
								let s = String(clusterUrl || '')
									.trim()
									.replace(/^https?:\/\//i, '')
									.replace(/\/+$/, '')
									.replace(/:\d+$/, '');
								// Azure Data Explorer public cloud clusters
								s = s.replace(/\.kusto\.windows\.net$/i, '');
								return s;
							};

							const __kustoParseFullyQualifiedTableExpr = (text: any) => {
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

							const __kustoFindConnectionIdByClusterName = (clusterName: any) => {
								try {
									const target = __kustoNormalizeClusterForKusto(clusterName).toLowerCase();
									if (!target) return null;
									for (const c of (_win.connections || [])) {
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

							const __kustoEnsureSchemaForClusterDb = async (clusterName: any, databaseName: any) => {
								try {
									const cid = __kustoFindConnectionIdByClusterName(clusterName);
									const db = String(databaseName || '').trim();
									if (!cid || !db) return null;
									const key = cid + '|' + db;
									try {
										if (_win.schemaByConnDb && _win.schemaByConnDb[key]) {
											return _win.schemaByConnDb[key];
										}
									} catch { /* ignore */ }
									if (typeof _win.__kustoRequestSchema === 'function') {
										const sch = await _win.__kustoRequestSchema(cid, db, false);
										try {
											if (sch && _win.schemaByConnDb) {
												_win.schemaByConnDb[key] = sch;
											}
										} catch { /* ignore */ }
										return sch;
									}
								} catch { /* ignore */ }
								return null;
							};

							// Special context: inside `| join ... on ...` or `| lookup ... on ...` we want columns (not tables).
							const __kustoBuildLetTabularResolverForCompletion = (text: any) => {
								const tablesByLower: any = {};
								try {
									for (const t of (schema && Array.isArray(schema.tables) ? schema.tables : [])) {
										tablesByLower[String(t).toLowerCase()] = String(t);
									}
								} catch { /* ignore */ }
								const letSources: any = {};
								const extractSourceLower = (rhsText: any) => {
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
								const resolve = (name: any) => {
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
								return (name: any) => __kustoFindSchemaTableName(name) || (resolveLet ? resolveLet(name) : null);
							})();

							const __kustoGetLastTopLevelStageText = (text: any, offset: any) => {
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

							const __kustoExtractJoinOrLookupRightTable = (clauseText: any) => {
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
							const inferActiveTable = (text: any) => {
								__kustoActiveTabularContext = null;
								// Prefer last explicit join/lookup/from target.
								try {
									const refs: any[] = [];
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

							const __kustoFindSchemaTableName = (name: any) => {
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

							const __kustoSplitCommaList = (s: any) => {
								if (!s) return [];
								return String(s)
									.split(',')
									.map(x => x.trim())
									.filter(Boolean);
							};

							const __kustoComputeAvailableColumnsAtOffset = async (fullText: any, offset: any) => {
								const columnsByTable = __kustoGetColumnsByTable(schema);
								if (!schema || !columnsByTable) return null;

								const __kustoParseJoinKind = (stageText: any) => {
									try {
										const m = String(stageText || '').match(/\bkind\s*=\s*([A-Za-z_][\w-]*)\b/i);
										return m && m[1] ? String(m[1]).toLowerCase() : '';
									} catch { return ''; }
								};

								const __kustoJoinOutputMode = (kindLower: any) => {
									const k = String(kindLower || '').toLowerCase();
									if (!k) return 'union';
									if (k.includes('leftanti') || k.includes('leftsemi') || k === 'anti' || k === 'semi') return 'left';
									if (k.includes('rightanti') || k.includes('rightsemi')) return 'right';
									return 'union';
								};

								const __kustoExtractFirstParenGroup = (text: any) => {
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

								const __kustoInferSourceFromText = (text: any) => {
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

								const __kustoComputeColumnsForPipelineText = async (pipelineText: any) => {
									const parts = __kustoSplitPipelineStagesDeep(String(pipelineText || ''));
									if (!parts || parts.length === 0) return null;
									const src = __kustoInferSourceFromText(parts[0]);
									let cols = null;
									if (src && src.kind === 'fq') {
										const otherSchema = await __kustoEnsureSchemaForClusterDb(src.cluster, src.database);
											const otherColsByTable = __kustoGetColumnsByTable(otherSchema);
											if (otherColsByTable && otherColsByTable[src.table as string]) {
												cols = Array.from(otherColsByTable[src.table as string]);
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
													const set: any = new Set(cols);
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
														cols = cols.filter((c: any) => c !== m[2]);
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
												if (remove.size) cols = cols.filter((c: any) => !remove.has(c));
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
													const set: any = new Set(cols);
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
													const set: any = new Set(cols);
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
													const set: any = new Set(cols);
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
											const rightCols: any = rightExpr ? await __kustoComputeColumnsForPipelineText(rightExpr) : null;
											if (mode === 'right' && rightCols) { cols = Array.from(rightCols); continue; }
											if (mode === 'left') { continue; }
											if (rightCols) {
												const set: any = new Set(cols);
												for (const c of rightCols) if (!set.has(c)) set.add(c);
												cols = Array.from(set);
											}
											continue;
										}
									}

									return cols;
								};

								const __kustoComputeLetColumns = async (letNameLower: any) => {
									const key = String(letNameLower || '').toLowerCase();
									if (!key) return null;
									if (__kustoLetColsMemo.has(key)) return __kustoLetColsMemo.get(key);
									if (__kustoLetInProgress.has(key)) return null;
									const rhs = __kustoLetRhsByLower.get(key);
									if (!rhs) return null;
									__kustoLetInProgress.add(key);
									try {
										const cols: any = await __kustoComputeColumnsForPipelineText(rhs);
										__kustoLetColsMemo.set(key, cols);
										return cols;
									} finally {
										__kustoLetInProgress.delete(key);
									}
								};

								const __kustoBuildLetTabularResolver = (text: any) => {
									const tablesByLower: any = {};
									try {
										for (const t of (schema && Array.isArray(schema.tables) ? schema.tables : [])) {
											tablesByLower[String(t).toLowerCase()] = String(t);
										}
									} catch { /* ignore */ }

									const letSources: any = {};
									const extractSourceLower = (rhsText: any) => {
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

									const resolveToContext = async (name: any) => {
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
								const __kustoResolveToSchemaTableName = (name: any) => __kustoFindSchemaTableName(name);
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
										const set: any = new Set(cols);
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
																const set: any = new Set(cols);
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
											const set: any = new Set(cols);
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
											const set: any = new Set(cols);
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
								let columnsByTable: any = null;
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
										columnsByTable = __kustoGetColumnsByTable(schema);
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
								const __kustoBuildFnInsertText = (fnName: any, fnDoc: any) => {
									const args = (fnDoc && Array.isArray(fnDoc.args)) ? fnDoc.args : [];
									const required = args.filter((a: any) => typeof a === 'string' && !a.endsWith('?'));
									if (required.length === 0) {
										return { insertText: fnName + '()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet };
									}
									const snippetArgs = required.map((a: any, i: any) => '${' + (i + 1) + ':' + a + '}').join(', ');
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
					// DISABLED: Custom completion provider - monaco-kusto now handles completions
					// monaco.languages.registerCompletionItemProvider('kusto', __kustoCompletionProvider);

					// --- Live diagnostics (markers) + quick fixes ---
					const KUSTO_DIAGNOSTICS_OWNER = 'kusto-diagnostics';

					const __kustoMaskCommentsPreserveLayout = (text: any) => {
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

					const __kustoFilterMarkersByAutocomplete = async (model: any, markers: any) => {
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
							const getLabelsAt = async (lineNumber: any, column: any) => {
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

					const __kustoClamp = (n: any, min: any, max: any) => Math.max(min, Math.min(max, n));

					const __kustoSplitTopLevelStatements = (text: any) => {
						// Split on ';' and blank lines when not inside strings/comments/brackets.
						const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
						const out = [];
						let start = 0;
						let depth = 0;
						let inLineComment = false;
						let inBlockComment = false;
						let inSingle = false;
						let inDouble = false;
						let inTripleBacktick = false;
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
							// KQL triple-backtick multi-line string literal: everything between ``` and ``` is string content.
							if (inTripleBacktick) {
								if (ch === '`' && next === '`' && raw[i + 2] === '`') {
									inTripleBacktick = false;
									i += 2;
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

							// Detect triple-backtick string literal opening (must check before single-char backtick use)
							if (ch === '`' && next === '`' && raw[i + 2] === '`') {
								inTripleBacktick = true;
								i += 2;
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

					const __kustoSplitPipelineStagesDeep = (text: any) => {
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

					const __kustoFindLastTopLevelPipeBeforeOffset = (text: any, offset: any) => {
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

					const __kustoGetActivePipeStageInfoBeforeOffset = (stmtText: any, offsetInStmt: any) => {
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

					const __kustoParsePipeHeaderFromLine = (trimmedPipeLine: any) => {
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

					const __kustoPipeHeaderAllowsIndentedContinuation = (pipeHeader: any) => {
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

					const __kustoGetStatementStartAtOffset = (text: any, offset: any) => {
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

					const __kustoBuildLineStarts = (text: any) => {
						const starts = [0];
						for (let i = 0; i < text.length; i++) {
							const ch = text.charCodeAt(i);
							if (ch === 10 /* \n */) {
								starts.push(i + 1);
							}
						}
						return starts;
					};

					const __kustoOffsetToPosition = (lineStarts: any, offset: any) => {
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

					const __kustoIsIdentStart = (ch: any) => {
						return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95; // A-Z a-z _
					};
					const __kustoIsIdentPart = (ch: any) => {
						return __kustoIsIdentStart(ch) || (ch >= 48 && ch <= 57) || ch === 45; // 0-9 -
					};

					const __kustoScanIdentifiers = (text: any) => {
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

					const __kustoLevenshtein = (a: any, b: any) => {
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

					const __kustoBestMatches = (needle: any, candidates: any, maxCount: any) => {
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

					const __kustoGetSchemaForModel = (model: any) => {
						let boxId = null;
						try {
							boxId = model && model.uri ? (_win.queryEditorBoxByModelUri[model.uri.toString()] || null) : null;
						} catch { boxId = null; }
						if (!boxId) {
							boxId = _win.activeQueryEditorBoxId;
						}
						return { boxId, schema: boxId ? (_win.schemaByBoxId[boxId] || null) : null };
					};

					const __kustoComputeDiagnostics = (text: any, schema: any) => {
						const markers: any[] = [];
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

						const __kustoIsTabularParamInScope = (nameLower: any, offset: any) => {
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
							const tablesByLower: any = {};
							try {
								for (const t of tables) {
									tablesByLower[String(t).toLowerCase()] = String(t);
								}
							} catch { /* ignore */ }
							const letSources: any = {};
							const extractSourceLower = (rhsText: any) => {
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
							return (nameLower: any) => {
								let cur = String(nameLower || '').toLowerCase();
								for (let depth = 0; depth < 8; depth++) {
									if (tablesByLower[cur]) return tablesByLower[cur];
									if (!letSources[cur]) return null;
									cur = letSources[cur];
								}
								return null;
							};
						})();

												const __kustoParseFullyQualifiedTableExpr = (text: any) => {
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
						const reportUnknownName = (code: any, name: any, startOffset: any, endOffset: any, candidates: any, what: any) => {
							const start = __kustoOffsetToPosition(lineStarts, startOffset);
							const end = __kustoOffsetToPosition(lineStarts, Math.max(startOffset + 1, endOffset));
													const prefixLower = String(name || '').toLowerCase();
													const filtered = prefixLower
														? (candidates || []).filter((c: any) => String(c || '').toLowerCase().startsWith(prefixLower))
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
																if (tables.length && !tables.some((t: any) => String(t).toLowerCase() === srcName.toLowerCase())) {
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
												if (tables.length && !tables.some((t: any) => String(t).toLowerCase() === name.toLowerCase())) {
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
										_win.__kustoDiagLog('pipe line', {
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
								const extractJoinOrLookupRightTable = (seg: any) => {
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
									if (tables.length && !tables.some((t: any) => String(t).toLowerCase() === String(name).toLowerCase())) {
										const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
										const startOffset = baseOffset + idx + Math.max(0, localStart);
										reportUnknownName('KW_UNKNOWN_TABLE', name, startOffset, startOffset + String(name).length, __kustoTabularNameCandidates, 'table');
									}
								}
							} catch { /* ignore */ }
						}

						// Column checks: best-effort pipeline simulation at top-level (depth 0).
						if (tables.length && columnsByTable) {
							const isDynamicType = (t: any) => {
								const v = String(t ?? '').trim().toLowerCase();
								return v === 'dynamic' || v.includes('dynamic') || v === 'system.object' || v.includes('system.object') || v === 'object';
							};
							const getDynamicColumnsForTable = (table: any) => {
								const set = new Set();
								if (!table || !columnTypesByTable) return set;
								const types = columnTypesByTable[table];
								if (!types || typeof types !== 'object') return set;
								for (const [col, typ] of Object.entries(types)) {
									if (isDynamicType(typ)) set.add(String(col));
								}
								return set;
							};
							const getDotChainRoot = (s: any, identStart: any) => {
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
								const stringRanges: any[] = [];
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
								const isInStringLiteral = (localOffset: any) => {
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
										const found = tables.find((t: any) => String(t).toLowerCase() === String(letSource).toLowerCase());
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
											const found = tables.find((t: any) => String(t).toLowerCase() === String(name).toLowerCase());
											if (found && columnsByTable[found]) { activeTable = found; break; }
											const resolvedLet = __kustoResolveTabularLetToTable(String(name).toLowerCase());
											if (resolvedLet && columnsByTable[resolvedLet]) { activeTable = resolvedLet; break; }
										}
									}
								} catch { activeTable = null; }

								let colSet: any = null;
								let dynamicRootCols = new Set();
								if (activeTable) {
									colSet = new Set((columnsByTable[activeTable] || []).map((c: any) => String(c)));
									dynamicRootCols = getDynamicColumnsForTable(activeTable);
								}

								const reportUnknownColumn = (name: any, localStartOffset: any, localEndOffset: any, candidates: any) => {
									reportUnknownName('KW_UNKNOWN_COLUMN', name, baseOffset + localStartOffset, baseOffset + localEndOffset, candidates, 'column');
								};

								const currentColumns = () => {
									if (!colSet) return [];
									return Array.from(colSet);
								};

								const isFunctionCall = (idx: any) => {
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
												const splitTopLevelCommaList = (s: any) => {
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

				// DISABLED: Custom diagnostics - monaco-kusto now handles validation via its language service
				// The function stub is kept for backwards compatibility with existing callers.
				_win.__kustoScheduleKustoDiagnostics = function (boxId: any, delayMs: any) {
					// Monaco-kusto provides its own diagnostics/validation, so this is now a no-op.
					return;
				};

					// Hover provider for diagnostics (shown on red underline hover).
					monaco.languages.registerHoverProvider('kusto', {
						provideHover: function (model: any, position: any) {
							try {
								const markers = monaco.editor.getModelMarkers({ owner: KUSTO_DIAGNOSTICS_OWNER, resource: model.uri });
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
											try { delete _win.__kustoMonacoLoadedSchemasByModel[uriKey]; } catch { /* ignore */ }
										}
										if (_win.__kustoMonacoDatabaseInContextByModel && _win.__kustoMonacoDatabaseInContextByModel[uriKey]) {
											try { delete _win.__kustoMonacoDatabaseInContextByModel[uriKey]; } catch { /* ignore */ }
										}
										if (_win.__kustoMonacoInitializedByModel && _win.__kustoMonacoInitializedByModel[uriKey]) {
											try { delete _win.__kustoMonacoInitializedByModel[uriKey]; } catch { /* ignore */ }
										}
										if (_win.__kustoModelClusterMap && _win.__kustoModelClusterMap[uriKey]) {
											try { delete _win.__kustoModelClusterMap[uriKey]; } catch { /* ignore */ }
										}
									} catch { /* ignore */ }
								});
							}
						} catch { /* ignore */ }

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
																	} catch { /* ignore */ }
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
																		await worker.addDatabaseToSchema(modelKey, otherClusterUrl, databaseSchema);
																	// NOTE: Do NOT mark as loaded! Re-added schemas are only for cross-cluster references.
																	// They are NOT primary schemas and need full REPLACE when actually focused.
																} else {
																	// re-add failed - no databaseSchema found
																}
															} catch (readdError) {
																// re-add failed for otherKey
															}
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
											if (typeof worker.normalizeSchema === 'function' && typeof worker.addDatabaseToSchema === 'function') {
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
														// Add the database to the existing schema in the worker
																			await worker.addDatabaseToSchema(modelKey, clusterUrl, databaseSchema);
																			perModelLoadedSchemas[schemaKey] = true;
																			// Keep legacy/global in sync for debugging only
																			_win.__kustoMonacoLoadedSchemas[schemaKey] = true;
														
														// Cache the schema for re-adding after future cluster switches
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
							} catch { /* ignore */ }
							
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
							} catch (e) { /* ignore */ }
							
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
									} catch { /* ignore */ }
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
										} catch { /* ignore */ }
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
												try { schemaObj = JSON.parse(schemaObj); } catch { /* ignore */ }
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
						} catch (e) {
							// Error enabling markers, non-critical
						}
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
									} catch (e) {
									}
								}
							}
						} catch (e) {
							// Error in revalidation, non-critical
						}
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
												
																// Apply to ALL models so whichever box gets focus has the schema available
																const loadedKey = `${clusterUrl}|${database}`;
																let appliedCount = 0;
																for (const model of models) {
																	try {
																		const worker = await workerAccessor(model.uri);
																		if (worker && typeof worker.addDatabaseToSchema === 'function') {
																			// clusterName should be exactly what the user typed (e.g., 'help' or 'https://help.kusto.windows.net')
																		await worker.addDatabaseToSchema(model.uri.toString(), clusterName, databaseSchema);
																			appliedCount++;
																			_win.__kustoMonacoLoadedSchemasByModel = _win.__kustoMonacoLoadedSchemasByModel || {};
																			_win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()] = _win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()] || {};
																			_win.__kustoMonacoLoadedSchemasByModel[model.uri.toString()][loadedKey] = true;
																		}
																	} catch { /* ignore */ }
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
											} catch { /* ignore */ }
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
								} catch { /* ignore */ }

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
									_win.vscode.postMessage({
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
											_win.vscode.postMessage({
												type: 'showInfo',
												message: 'Copilot returned no inline suggestions. Often, trying again helps, especially after changing the position of the cursor.'
											});
										} catch { /* ignore */ }
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
		try { _win.monacoReadyPromise = null; } catch { /* ignore */ }
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
			} catch {
				// ignore
			}
		}, 0);
	}
} catch {
	// ignore
}

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
				try { _win.__kustoMonacoLoadedSchemasByModel = {}; } catch { /* ignore */ }
				try { _win.__kustoMonacoDatabaseInContextByModel = {}; } catch { /* ignore */ }
				try { _win.__kustoMonacoInitializedByModel = {}; } catch { /* ignore */ }
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
												} catch {
													// ignore
												}
											}
										}
						}
					} catch {
						// Ignore - best effort
					}
				})();
			}
			// Tab became visible - don't reload yet, wait for user to focus a query box
		} catch {
			// ignore
		}
	}, true);
} catch {
	// ignore
}

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
			} catch {
				// ignore
			}
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
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete _win.queryEditors[boxId]; } catch { /* ignore */ }
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
			const pending = _win.__kustoPendingWrapperHeightPxByBoxId && _win.__kustoPendingWrapperHeightPxByBoxId[boxId];
			if (typeof pending === 'number' && Number.isFinite(pending) && pending > 0) {
				let w = wrapper;
				if (!w) {
					const box = document.getElementById(boxId);
					w = (box && box.querySelector) ? box.querySelector('.query-editor-wrapper') : null;
				}
				if (w) {
					(w as any).style.height = Math.round(pending) + 'px';
					try { (w as any).dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
					// Also update the manual height map so __kustoGetWrapperHeightPx returns consistent values.
					try {
						if (!_win.__kustoManualQueryEditorHeightPxByBoxId || typeof _win.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
							_win.__kustoManualQueryEditorHeightPxByBoxId = {};
						}
						_win.__kustoManualQueryEditorHeightPxByBoxId[boxId] = Math.round(pending);
					} catch { /* ignore */ }
				}
				try { delete _win.__kustoPendingWrapperHeightPxByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Avoid calling editor.setValue() during initialization; pass initial value into create()
		// to reduce async timing races in VS Code webviews.
		let initialValue = '';
		try {
			const pending = _win.__kustoPendingQueryTextByBoxId && _win.__kustoPendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete _win.__kustoPendingQueryTextByBoxId[boxId]; } catch { /* ignore */ }
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
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none',
			// Enable inline suggestions (ghost text completions from Copilot)
			inlineSuggest: { enabled: true }
		});

		// Keep Monaco's suggest widget usable inside the editor bounds.
		try { __kustoInstallSmartSuggestWidgetSizing(editor); } catch { /* ignore */ }

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
						} catch { /* ignore */ }
					}, 50);
				} catch { /* ignore */ }
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
				} catch { /* ignore */ }
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
				} catch { /* ignore */ }
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
				editor.onDidChangeCursorPosition((e: any) => {
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
				if (typeof _win.__kustoStatementSeparatorMinBlankLines !== 'number') {
					_win.__kustoStatementSeparatorMinBlankLines = 1;
				}
			} catch { /* ignore */ }
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
			} catch { /* ignore */ }
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
			} catch { /* ignore */ }
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
							} catch { /* ignore */ }
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
			} catch { /* ignore */ }

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
				} catch { /* ignore */ }
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
					} catch { /* ignore */ }
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
						} catch { /* ignore */ }
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
						_win.__kustoAutoFindStateByBoxId[bid] = { term: usedTerm, ts: Date.now() };
					} catch { /* ignore */ }
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
					try { delete _win.__kustoAutoFindStateByBoxId[bid]; } catch { /* ignore */ }
					const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[bid] : null;
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

		_win.queryEditors[boxId] = editor;
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
				} catch { /* ignore */ }

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
						try { if (ctrl && ctrl._widget) candidates.push(ctrl._widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.widget) candidates.push(ctrl.widget); } catch { /* ignore */ }
						try { if (ctrl && ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch { /* ignore */ }
						try { if (ctrl && ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch { /* ignore */ }

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
							} catch { /* ignore */ }
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
							} catch { /* ignore */ }
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

		const __kustoMaybeAutoTriggerAutocomplete = (ed: any, boxId: any, changeEvent: any) => {
			try {
				if (!ed) return;
				if (typeof _win.autoTriggerAutocompleteEnabled !== 'boolean' || !_win.autoTriggerAutocompleteEnabled) return;
				// Only auto-trigger for the currently focused query editor.
				try {
					if (typeof _win.activeQueryEditorBoxId === 'string' && _win.activeQueryEditorBoxId !== boxId) {
						return;
					}
				} catch { /* ignore */ }
				try {
					if (typeof ed.hasTextFocus === 'function' && !ed.hasTextFocus()) {
						return;
					}
				} catch { /* ignore */ }

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
								} catch { /* ignore */ }
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
				} catch { /* ignore */ }

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
						} catch { /* ignore */ }

						ed.__kustoAutoSuggestLastTriggeredAt = now;
						__kustoTriggerAutocomplete(ed);
					} catch { /* ignore */ }
				}, 140);
			} catch {
				// ignore
			}
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
			if (typeof _win.__kustoTriggerAutocompleteForBoxId !== 'function') {
				_win.__kustoTriggerAutocompleteForBoxId = (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
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

		const __kustoReplaceAllText = (ed: any, nextText: any, label: any) => {
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
			if (typeof _win.__kustoSingleLineQueryForBoxId !== 'function') {
				_win.__kustoSingleLineQueryForBoxId = (id: any) => {
					try {
						const ed = (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) ? _win.queryEditors[id] : null;
						if (!ed) return;
						const v = ed.getValue ? ed.getValue() : '';
						const next = __kustoToSingleLineKusto(v);
						__kustoReplaceAllText(ed, next, 'kusto-single-line');
					} catch {
						// ignore
					}
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
					} catch {
						// ignore
					}
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
									try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to copy that statement as a single line.' }); } catch { /* ignore */ }
									return;
								}
							}
						} catch { /* ignore */ }
						const single = __kustoToSingleLineKusto(v);

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(single);
								try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch { /* ignore */ }
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
						try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch { /* ignore */ }
					} catch {
						try { _win.vscode && _win.vscode.postMessage && _win.vscode.postMessage({ type: 'showInfo', message: 'Failed to copy single-line query to clipboard.' }); } catch { /* ignore */ }
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

		// Shift+Space triggers Copilot inline suggestions (ghost text) on demand.
		try {
			editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Space, () => {
				console.log('[Kusto] SHIFT+SPACE triggered - requesting inline suggestions');
				editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
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
					if (typeof _win.executeQuery === 'function') {
						_win.executeQuery(boxId);
						return;
					}
					if (window && typeof _win.executeQuery === 'function') {
						_win.executeQuery(boxId);
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
			} catch {
				// ignore
			}
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
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }

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
								try { _win.__kustoWebviewHasFocus = false; } catch { /* ignore */ }
								// After focus flips, refresh the active overlay once so it can freeze/restore docs.
								try {
									setTimeout(() => {
										try {
											if (typeof _win.__kustoRefreshActiveCaretDocs === 'function') {
												_win.__kustoRefreshActiveCaretDocs();
											}
										} catch { /* ignore */ }
									}, 0);
								} catch { /* ignore */ }
							},
							true
						);
					} catch { /* ignore */ }
					try { window.addEventListener('focus', () => { try { _win.__kustoWebviewHasFocus = true; } catch { /* ignore */ } }, true); } catch { /* ignore */ }
					try {
						document.addEventListener('visibilitychange', () => {
							try {
								// When the tab becomes hidden, treat as unfocused.
								_win.__kustoWebviewHasFocus = !document.hidden;
							} catch { /* ignore */ }
						}, true);
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }

			const isWebviewFocused = () => {
				try {
					if (typeof _win.__kustoWebviewHasFocus === 'boolean') {
						return !!_win.__kustoWebviewHasFocus;
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
						if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
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
									if (typeof _win.__kustoWebviewHasFocus === 'boolean' && _win.__kustoWebviewHasFocus === false) {
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
						const activeId = (typeof _win.activeQueryEditorBoxId !== 'undefined' && _win.activeQueryEditorBoxId)
							? String(_win.activeQueryEditorBoxId)
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
									if (_win.__kustoCaretDocsLastHtmlByBoxId && typeof _win.__kustoCaretDocsLastHtmlByBoxId === 'object') {
										_win.__kustoCaretDocsLastHtmlByBoxId[boxId] = html;
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
						if (typeof _win.caretDocOverlaysByBoxId !== 'undefined' && _win.caretDocOverlaysByBoxId) {
							_win.caretDocOverlaysByBoxId[boxId] = docOverlay;
						}
					} catch { /* ignore */ }

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
								} catch {
									// ignore
								}
							};
								try {
									// Allow other features (e.g., async doc fetch) to request a re-render of the active caret-docs banner.
									_win.__kustoRefreshActiveCaretDocs = refreshActive;
								} catch { /* ignore */ }
							window.addEventListener('scroll', refreshActive, true);
							window.addEventListener('resize', refreshActive);
						}
					} catch {
						// ignore
					}

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
						} catch { /* ignore */ }
					}
				} catch {
					// ignore
				}
			});
		} catch {
			// ignore
		}
		let docTimer: any = null;
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
				_win.queryEditorBoxByModelUri[model.uri.toString()] = boxId;
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
			} catch {
				// ignore
			}
			try {
				if (typeof _win.__kustoScheduleKustoDiagnostics === 'function') {
					_win.__kustoScheduleKustoDiagnostics(boxId, 250);
				}
			} catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
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
			} catch { /* ignore */ }
			try { __kustoMaybeAutoTriggerAutocomplete(editor, boxId, e); } catch { /* ignore */ }
		});
		editor.onDidFocusEditorText(() => {
			_win.activeQueryEditorBoxId = boxId;
			try { _win.activeQueryEditorBoxId = boxId; } catch { /* ignore */ }
			try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
			try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
			try { _win.__kustoLastMonacoInteractionAt = Date.now(); } catch { /* ignore */ }
			try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
			syncPlaceholder();
			_win.ensureSchemaForBox(boxId);
			scheduleDocUpdate();
			// Update monaco-kusto schema if switching to a different cluster/database
			try {
				if (typeof _win.__kustoUpdateSchemaForFocusedBox === 'function') {
					_win.__kustoUpdateSchemaForFocusedBox(boxId);
				}
			} catch { /* ignore */ }
			try {
				if (typeof _win.__kustoScheduleKustoDiagnostics === 'function') {
					_win.__kustoScheduleKustoDiagnostics(boxId, 0);
				}
			} catch { /* ignore */ }
			// Check for cross-cluster references on focus (in addition to content change)
			try {
				if (typeof _win.__kustoCheckCrossClusterRefs === 'function') {
					// Small delay to let the schema load first
					setTimeout(() => {
						_win.__kustoCheckCrossClusterRefs(editor.getValue(), boxId);
					}, 100);
				}
			} catch { /* ignore */ }
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				_win.activeQueryEditorBoxId = boxId;
				try { _win.activeQueryEditorBoxId = boxId; } catch { /* ignore */ }
				try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
				try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
				try { _win.__kustoLastMonacoInteractionAt = Date.now(); } catch { /* ignore */ }
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
								if (typeof _win.caretDocsEnabled !== 'undefined' && _win.caretDocsEnabled === false) {
									docOverlay.hide();
								}
							} catch { /* ignore */ }
							if (_win.activeQueryEditorBoxId === boxId) {
								_win.activeQueryEditorBoxId = null;
								try { _win.activeQueryEditorBoxId = null; } catch { /* ignore */ }
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
							} catch { /* ignore */ }
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
				try { _win.activeQueryEditorBoxId = boxId; } catch { /* ignore */ }
				try { _win.activeMonacoEditor = editor; } catch { /* ignore */ }
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
				} catch {
					// ignore
				}
				try { __kustoForceEditorWritable(editor); } catch { /* ignore */ }
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
			} catch {
				// ignore
			}
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
			if (typeof _win.__kustoOnQueryValueChanged === 'function') {
				_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
			}
		} catch {
			// ignore
		}

		// Note: we intentionally do NOT auto-trigger Monaco suggestions on typing.
		// Users can trigger via Ctrl+Space or the toolbar button.

		// Keep Monaco laid out when the user resizes the wrapper.
		if (wrapper && typeof ResizeObserver !== 'undefined') {
			if (_win.queryEditorResizeObservers[boxId]) {
				try { _win.queryEditorResizeObservers[boxId].disconnect(); } catch { /* ignore */ }
			}
			const ro = new ResizeObserver(() => {
				try { editor.layout(); } catch { /* ignore */ }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch { /* ignore */ }
			});
			ro.observe(wrapper);
			_win.queryEditorResizeObservers[boxId] = ro;
		}

		// In multi-editor layouts (e.g. Copilot split panes), editors can be created while hidden.
		// Ensure we relayout when the wrapper becomes visible again so Monaco widgets position correctly.
		try {
			if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers && _win.queryEditorVisibilityObservers[boxId]) {
				try { _win.queryEditorVisibilityObservers[boxId].disconnect(); } catch { /* ignore */ }
				try { delete _win.queryEditorVisibilityObservers[boxId]; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try {
			if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers && _win.queryEditorVisibilityMutationObservers[boxId]) {
				try { _win.queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch { /* ignore */ }
				try { delete _win.queryEditorVisibilityMutationObservers[boxId]; } catch { /* ignore */ }
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
				try { if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers) _win.queryEditorVisibilityObservers[boxId] = io; } catch { /* ignore */ }
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
				try { if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers) _win.queryEditorVisibilityMutationObservers[boxId] = mo; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Initialize toolbar overflow handling (shows "..." button when buttons overflow)
		try {
			if (typeof _win.initToolbarOverflow === 'function') {
				_win.initToolbarOverflow(boxId);
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
					(w as any).dataset.kustoUserResized = 'true';
					try { delete (w as any).dataset.kustoAutoResized; } catch { /* ignore */ }
				} catch { /* ignore */ }
				try {
					if (!_win.__kustoManualQueryEditorHeightPxByBoxId || typeof _win.__kustoManualQueryEditorHeightPxByBoxId !== 'object') {
						_win.__kustoManualQueryEditorHeightPxByBoxId = {};
					}
				} catch { /* ignore */ }

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
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					// Use a larger min-height when the Copilot chat is visible.
					let minHeightPx = 120;
					try {
						const split = w.querySelector('.kusto-copilot-split');
						if (split && !split.classList.contains('kusto-copilot-chat-hidden')) {
							minHeightPx = 180;
						}
					} catch { /* ignore */ }
					// Manual resizing should not have a max height cap.
					const nextHeight = Math.max(minHeightPx, startHeight + delta);
					(w as any).style.height = nextHeight + 'px';
					try {
						if (_win.__kustoManualQueryEditorHeightPxByBoxId && typeof _win.__kustoManualQueryEditorHeightPxByBoxId === 'object') {
							_win.__kustoManualQueryEditorHeightPxByBoxId[boxId] = Math.round(nextHeight);
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
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
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
				} catch { /* ignore */ }
			});
		}
	}).catch((e: any) => {
		// If Monaco fails to initialize transiently, retry a few times so the editor
		// doesn't get stuck in a non-interactive placeholder state until reopen.
		try {
			if (_win.queryEditors && _win.queryEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

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

// ── Window bridges for remaining legacy callers ──
(window as any).__kustoGetColumnsByTable = __kustoGetColumnsByTable;
(window as any).ensureMonaco = ensureMonaco;
(window as any).initQueryEditor = initQueryEditor;
