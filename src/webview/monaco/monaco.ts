// Monaco module — converted from legacy/monaco.js
// Monaco Editor configuration, completions, column inference, caret docs overlay.
// Window bridge exports at bottom for remaining legacy callers.
import { pState } from '../shared/persistence-state';
import { schedulePersist } from '../core/persistence';

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
} from './prettify';
import {
	isDarkTheme,
	getVSCodeEditorBackground,
	defineCustomThemes,
	applyMonacoTheme,
	startMonacoThemeObserver,
} from './theme';
import {
	__kustoNormalizeTextareasWritable,
	__kustoForceEditorWritable,
	__kustoInstallWritableGuard,
	__kustoEnsureEditorWritableSoon,
	__kustoEnsureAllEditorsWritableSoon,
} from './writable';
import {
	__kustoIsElementVisibleForSuggest,
	__kustoGetWordNearCursor,
	__kustoFindSuggestWidgetForEditor,
	__kustoRegisterGlobalSuggestMutationHandler,
	__kustoInstallSmartSuggestWidgetSizing,
} from './suggest';
import {
	__kustoGetStatementStartAtOffset,
	__kustoScanIdentifiers,
	__kustoSplitTopLevelStatements,
	__kustoSplitPipelineStagesDeep,
	__kustoScheduleKustoDiagnostics,
} from './diagnostics';
import { __kustoInitCompletionDeps } from './completions';
import {
	initCaretDocsDeps,
	getHoverInfoAt, KUSTO_FUNCTION_DOCS, KUSTO_KEYWORD_DOCS,
	findEnclosingFunctionCall, getTokenAtPosition,
	KUSTO_CONTROL_COMMAND_DOCS_BASE_URL, KUSTO_CONTROL_COMMAND_DOCS_VIEW, __kustoControlCommands,
} from './caret-docs';
import { __kustoAttachAutoResizeToContent } from './resize';
import { escapeHtml, getScrollY, maybeAutoScrollWhileDragging } from '../core/utils';
import { __kustoAutoSizeEditor, ensureSchemaForBox, __kustoGetConnectionId, __kustoGetDatabase } from '../modules/queryBoxes';
import { executeQuery } from '../modules/queryBoxes-execution';
import { initToolbarOverflow } from '../modules/queryBoxes-toolbar';
import { postMessageToHost } from '../shared/webview-messages';
import { decideSchemaOperation } from '../shared/schema-decision';
import { SchemaTracker } from '../shared/schema-tracker';
import {
	connections,
	monacoReadyPromise,
	setMonacoReadyPromise,
	activeQueryEditorBoxId,
	setActiveQueryEditorBoxId,
	setActiveMonacoEditor,
	autoTriggerAutocompleteEnabled,
	copilotInlineCompletionsEnabled,
	caretDocsEnabled,
	queryEditors,
	queryEditorBoxByModelUri,
	schemaByBoxId,
	copilotInlineCompletionRequests,
	queryEditorResizeObservers,
	queryEditorVisibilityObservers,
	queryEditorVisibilityMutationObservers,
	caretDocOverlaysByBoxId,
} from '../core/state';

// ── Schema state singleton (the ONLY source of truth for schema tracking) ───
export const __kustoSchemaTracker = new SchemaTracker();

const _win = window;

// Module-level variables for functions that span closure scopes (Scope A: require callback, Scope B: initQueryEditor callback).
// These replace _win.xxx bridge assignments for self-consumed functions.
let __kustoEnableMarkersForModel: ((modelUri: any) => void) | null = null;
let __kustoDisableMarkersForModel: ((modelUri: any) => void) | null = null;
let __kustoGetHoverInfoAt: ((model: any, position: any) => any) | null = null;
let __kustoSchemaOperationQueue: Promise<any> = Promise.resolve();
let __kustoSetMonacoKustoSchemaInternal: ((...args: any[]) => Promise<any>) | null = null;
let __kustoSetDatabaseInContext: ((...args: any[]) => Promise<boolean>) | null = null;
export let __kustoUpdateSchemaForFocusedBox: ((...args: any[]) => Promise<void>) | null = null;
let __kustoEnableMarkersForBox: ((boxId: any) => void) | null = null;
let __kustoTriggerRevalidation: ((boxId: any) => void) | null = null;
let __kustoExtractCrossClusterRefs: ((queryText: any) => any[]) | null = null;
let __kustoRequestCrossClusterSchema: ((clusterName: any, database: any, boxId: any) => void) | null = null;
let __kustoApplyCrossClusterSchemaInternal: ((...args: any[]) => Promise<void>) | null = null;
let __kustoCheckCrossClusterRefs: ((queryText: any, boxId: any) => void) | null = null;
let __kustoFocusInProgress: string | null = null;
let __kustoStatementSeparatorMinBlankLines = 1;
let __kustoGetStatementBlocksFromModel: ((model: any) => any[]) | null = null;
let __kustoIsSeparatorBlankLine: ((model: any, lineNumber: any) => boolean) | null = null;
let __kustoExtractStatementTextAtCursor: ((editor: any) => string | null) | null = null;

// Exported module-level lets for cross-module ES imports (lazily assigned inside require callback).
export let __kustoAutoFindInQueryEditor: ((boxId: any, term: any) => Promise<boolean>) | null = null;
let __kustoAutoFindStateByBoxId: Record<string, any> = {};

// Module-level state variables — converted from _win.__kusto* window bridges.
// Group A: Internal state (only used within monaco.ts)
let __kustoMarkersEnabledModels: Set<string> = new Set();
let __kustoModelClusterMap: Record<string, string> = {};
let __kustoMonacoDatabaseInContextByModel: Record<string, { clusterUrl: string; database: string } | null> = {};
let __kustoMonacoInitializedByModel: Record<string, boolean> = {};

let __kustoMonacoModelDisposeHookInstalled = false;
let __kustoCrossClusterCheckTimeout: Record<string, any> = {};
let __kustoWorkerInitialized = false;
let __kustoWorkerNeedsSchemaReload = false;
let __kustoLastFocusedBoxId: string | null = null;
let __kustoCaretDocsLastHtmlByBoxId: Record<string, string> = {};
let __kustoWebviewHasFocus = true;
let __kustoWebviewFocusListenersInstalled = false;
let __kustoCaretDocsViewportListenersInstalled = false;
let __kustoLastMonacoInteractionAt = 0;
// Group B: Cross-module state (exported for consumers in other modules)
// Control command doc cache + generated functions merged: authoritative source in monaco-caret-docs.ts
export { __kustoControlCommandDocCache, __kustoControlCommandDocPending } from './caret-docs';
export { __kustoGeneratedFunctionsMerged, setGeneratedFunctionsMerged } from './caret-docs';
export let __kustoCrossClusterSchemas: Record<string, any> = {};
export let __kustoMonacoInitRetryCountByBoxId: Record<string, number> = {};

// AMD globals loaded by require() — not available at module scope
// but referenced inside the require() callback and other functions.
declare const monaco: any;
declare const require: any;

// Derive `columnsByTable` from `columnTypesByTable` to avoid storing duplicate column lists.
// Falls back to legacy `columnsByTable` if present (older cached schema entries).
const __kustoColumnsByTableCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
export function __kustoGetColumnsByTable(schema: any) {
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

	setMonacoReadyPromise(new Promise((resolve, reject) => {
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
								__kustoMarkersEnabledModels = new Set();
								
								// Track model URI -> normalized cluster URL mapping
								// This allows us to suppress markers for models that don't match the current context
								__kustoModelClusterMap = {};
								
								monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any) {
									// Only intercept kusto markers
									if (owner === 'kusto') {
										const uri = model && model.uri ? model.uri.toString() : '';
										if (!__kustoMarkersEnabledModels.has(uri)) {
											// Suppress markers for models that haven't been focused yet
											return;
										}
										// CRITICAL: Suppress markers for models whose cluster doesn't match current context
										// monaco-kusto validates ALL models when schema changes, but we only want errors
										// for models that match the current schema context
										const modelCluster = __kustoModelClusterMap[uri];
										const currentCluster = __kustoSchemaTracker.databaseInContext?.clusterUrl;
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
__kustoEnableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									if (!__kustoMarkersEnabledModels.has(uri)) {
										__kustoMarkersEnabledModels.add(uri);
									}
								};
								
								// Function to disable markers for a specific model (called on blur)
								// This removes the model from the enabled set and clears existing markers
__kustoDisableMarkersForModel = function(modelUri: any) {
									if (!modelUri) return;
									const uri = typeof modelUri === 'string' ? modelUri : modelUri.toString();
									__kustoMarkersEnabledModels.delete(uri);
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

					// ── Caret docs loaded from monaco-caret-docs.ts ──
					initCaretDocsDeps(monaco);
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
					__kustoInitCompletionDeps({
						KUSTO_FUNCTION_DOCS,
						KUSTO_KEYWORD_DOCS,
						KUSTO_CONTROL_COMMAND_DOCS_BASE_URL,
						KUSTO_CONTROL_COMMAND_DOCS_VIEW,
						__kustoControlCommands,
						findEnclosingFunctionCall,
						getTokenAtPosition,
						__kustoGetStatementStartAtOffset,
						__kustoScanIdentifiers,
						__kustoSplitTopLevelStatements,
						__kustoSplitPipelineStagesDeep,
						__kustoGetColumnsByTable,
						ensureSchemaForBox,
					});


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
					__kustoGetHoverInfoAt = getHoverInfoAt;

					// --- monaco-kusto integration ---
					// Track which schemas have been loaded into the monaco-kusto worker
					// Key: "clusterUrl|database" -> true
					// This is separate from our UI schema cache - this tracks what's IN the worker
					// IMPORTANT: monaco-kusto keeps schema state per Monaco model URI (workerAccessor(modelUri)).
					// If we always target models[0], schema/context updates apply to the wrong query box.
					__kustoSchemaTracker.globalInitialized = false; // legacy/global (kept for logs)
					// Track the current database in context: { clusterUrl, database }
					__kustoSchemaTracker.databaseInContext = null; // legacy/global (current focused model)
					
					// Cache all raw schema data we receive, so we can re-add them after cluster switches
					// Key: `${clusterUrl}|${database}`, Value: { rawSchemaJson, clusterUrl, database }
					__kustoSchemaTracker.schemaCache = {};
					
					// Mutex to serialize schema operations - prevents race conditions during parallel loads
					__kustoSchemaOperationQueue = Promise.resolve();
					
					// Function to set/add schema in monaco-kusto worker for full IntelliSense support
					// Uses aggregate approach: first schema uses setSchemaFromShowSchema, 
					// subsequent schemas use addDatabaseToSchema to ADD without replacing
					_win.__kustoSetMonacoKustoSchema = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
						// Serialize schema operations to prevent race conditions
						const operationPromise = __kustoSchemaOperationQueue.then(async () => {
							return await __kustoSetMonacoKustoSchemaInternal!(rawSchemaJson, clusterUrl, database, setAsContext, modelUri, forceRefresh);
						}).catch((e: any) => {
							console.error('[monaco-kusto] Queued operation failed:', e);
						});
						__kustoSchemaOperationQueue = operationPromise;
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
__kustoSetMonacoKustoSchemaInternal = async function (rawSchemaJson: any, clusterUrl: any, database: any, setAsContext = false, modelUri: any = null, forceRefresh = false) {
						// Resolve which Monaco model this operation applies to
						const models = monaco?.editor?.getModels ? monaco.editor.getModels() : [];
						if (!models || models.length === 0) {
							return;
						}
						// Install model-dispose hook (once) to clean up per-model caches.
						try {
							if (!__kustoMonacoModelDisposeHookInstalled && monaco?.editor?.onWillDisposeModel) {
								__kustoMonacoModelDisposeHookInstalled = true;
								monaco.editor.onWillDisposeModel((model: any) => {
									try {
										const uriKey = model?.uri ? model.uri.toString() : null;
										if (!uriKey) return;
										__kustoSchemaTracker.disposeModel(uriKey);
										try { delete __kustoMonacoDatabaseInContextByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										try { delete __kustoMonacoInitializedByModel[uriKey]; } catch (e) { console.error('[kusto]', e); }
										try { delete __kustoModelClusterMap[uriKey]; } catch (e) { console.error('[kusto]', e); }
									} catch (e) { console.error('[kusto]', e); }
								});
							}
						} catch (e) { console.error('[kusto]', e); }

						const modelKey = modelUri ? (typeof modelUri === 'string' ? modelUri : modelUri.toString()) : models[0].uri.toString();
						__kustoMonacoDatabaseInContextByModel[modelKey] = __kustoMonacoDatabaseInContextByModel[modelKey] || null;
						__kustoMonacoInitializedByModel[modelKey] = !!__kustoMonacoInitializedByModel[modelKey];

						const schemaKey = `${clusterUrl}|${database}`;
						
						// Normalize cluster URLs for comparison (used for marker clearing)
						const normalizeClusterUrl = (url: any) => {
							if (!url) return '';
							let normalized = String(url).trim().toLowerCase();
							normalized = normalized.replace(/^https?:\/\//, '');
							normalized = normalized.replace(/\/+$/, '');
							return normalized;
						};

						// ── Decision: delegated to the tested SchemaTracker ──
						const { operation, alreadyLoaded } = __kustoSchemaTracker.decide(modelKey, clusterUrl, database, setAsContext, forceRefresh);

						// ── Schema diagnostics: decision ──
						console.log(
							'%c[schema-diag] DECISION: %s | schema: %s | model: %s | setAsContext: %s | forceRefresh: %s | perModelLoaded: %s | globalInit: %s | ctx: %s/%s',
							'color:#ff0;font-weight:bold',
							operation.action + ('reason' in operation ? ` (${(operation as any).reason})` : ''),
							schemaKey, modelKey.replace(/.*\//, ''),
							setAsContext, forceRefresh, alreadyLoaded, __kustoSchemaTracker.globalInitialized,
							__kustoSchemaTracker.databaseInContext?.clusterUrl || '(none)', __kustoSchemaTracker.databaseInContext?.database || '(none)'
						);

						if (operation.action === 'skip') {
							return;
						}
						// If the decision says we need to act but the schema was "already loaded",
						// clear the per-model tracking so the load/replace can proceed.
						if (alreadyLoaded) {
							const perModel = __kustoSchemaTracker.loadedSchemasByModel[modelKey];
							if (perModel) delete perModel[schemaKey];
						}
						
						try {
							if (!rawSchemaJson || !clusterUrl || !database) {
								return;
							}
							
							// Normalize the schema JSON
							let schemaObj = rawSchemaJson;
							if (typeof rawSchemaJson === 'string') {
								try { schemaObj = JSON.parse(rawSchemaJson); } catch (e) { console.error('[monaco-kusto] Failed to parse schema JSON:', e); return; }
							}
							if (schemaObj && schemaObj.Databases && !schemaObj.Plugins) {
								schemaObj = { Plugins: [], ...schemaObj };
							}
							
							// Get the kusto worker
							if (monaco && monaco.languages && monaco.languages.kusto && typeof monaco.languages.kusto.getKustoWorker === 'function') {
								const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting kusto worker')), 10000));
								const workerAccessor = await Promise.race([monaco.languages.kusto.getKustoWorker(), timeoutPromise]);
								
								if (modelKey) {
									const worker = await Promise.race([
										workerAccessor(monaco.Uri.parse(modelKey)),
										new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting worker proxy')), 10000))
									]);
									if (!worker) return;
									
									// Resolve database name case from schema
									let databaseInContext = database;
									if (schemaObj?.Databases) {
										const dbKeys = Object.keys(schemaObj.Databases);
										if (!dbKeys.includes(database)) {
											const matchedKey = dbKeys.find((k: string) => k.toLowerCase() === database.toLowerCase());
											if (matchedKey) databaseInContext = matchedKey;
										}
									}
									
									// ── FIRST-LOAD ──────────────────────────────────────────
									if (operation.action === 'first-load') {
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
											} catch (schemaError) {
												console.error('[monaco-kusto] setSchemaFromShowSchema failed:', schemaError);
											}
										}
									// ── REPLACE ──────────────────────────────────────────────
									} else if (operation.action === 'replace') {
										if (typeof worker.setSchemaFromShowSchema === 'function') {
											try {
												await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
												const otherKeys = __kustoSchemaTracker.recordReplace(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
												__kustoMonacoInitializedByModel[modelKey] = true;
												__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };

												// ── Schema diagnostics: replace completed ──
												console.log(
													'%c[schema-diag] REPLACE done → new context: %s/%s | re-adding %d other schemas: %s',
													'color:#0f0',
													clusterUrl, databaseInContext,
													otherKeys.length,
													otherKeys.join(', ') || '(none)'
												);
												
												// Re-add all other cached schemas
												for (const otherKey of otherKeys) {
													const cached = __kustoSchemaTracker.schemaCache[otherKey];
													if (cached?.rawSchemaJson) {
														try {
															const engineSchema = await worker.normalizeSchema(cached.rawSchemaJson, cached.clusterUrl, cached.database);
															let databaseSchema = engineSchema?.database;
															if (!databaseSchema && engineSchema?.cluster?.databases) {
																databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === cached.database.toLowerCase());
															}
															if (databaseSchema) {
																await worker.addDatabaseToSchema(models[0].uri.toString(), cached.clusterUrl, databaseSchema);
															}
														} catch (readdError) { console.error('[kusto]', readdError); }
													}
												}
												
												// Clear markers for boxes that don't match the new context
												const newClusterNorm = normalizeClusterUrl(clusterUrl);
												const allQueryBoxes = document.querySelectorAll('kw-query-section.query-box[box-id]');
												allQueryBoxes.forEach(box => {
													const otherBoxId = box.getAttribute('box-id');
													const boxEditor = queryEditors?.[otherBoxId as string];
													if (boxEditor) {
														const boxCluster = typeof (box as any).getClusterUrl === 'function' ? (box as any).getClusterUrl() : '';
														const boxClusterNorm = boxCluster ? normalizeClusterUrl(boxCluster) : null;
														if (boxClusterNorm && boxClusterNorm !== newClusterNorm) {
															const boxModel = boxEditor.getModel();
															if (boxModel) monaco.editor.setModelMarkers(boxModel, 'kusto', []);
														}
													}
												});
											} catch (schemaError) {
												console.error('[monaco-kusto] REPLACE: setSchemaFromShowSchema failed:', schemaError);
											}
										}
									// ── ADD ──────────────────────────────────────────────────
									} else if (operation.action === 'add') {
										let alreadyLoadedGlobally = !forceRefresh && __kustoSchemaTracker.isLoadedGlobally(schemaKey);
										if (alreadyLoadedGlobally) {
											__kustoSchemaTracker.recordAdoptGlobal(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
											if (setAsContext) {
												const switched = await __kustoSetDatabaseInContext!(clusterUrl, databaseInContext, modelKey);
												if (!switched) {
													__kustoSchemaTracker.invalidateGlobal(schemaKey, modelKey);
													alreadyLoadedGlobally = false;
												}
											}
										}
										if (!alreadyLoadedGlobally && typeof worker.normalizeSchema === 'function' && typeof worker.addDatabaseToSchema === 'function') {
											try {
												const engineSchema = await worker.normalizeSchema(schemaObj, clusterUrl, databaseInContext);
												let databaseSchema = engineSchema?.database;
												if (!databaseSchema && engineSchema?.cluster?.databases) {
													databaseSchema = engineSchema.cluster.databases.find((db: any) => db.name.toLowerCase() === databaseInContext.toLowerCase());
												}
												if (databaseSchema) {
													await worker.addDatabaseToSchema(models[0].uri.toString(), clusterUrl, databaseSchema);
													__kustoSchemaTracker.recordAdd(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj, setAsContext);
													__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
													// For setAsContext, also try getSchema/setSchema for reliable context switch
													if (setAsContext) {
														try {
															if (typeof worker.getSchema === 'function' && typeof worker.setSchema === 'function') {
																const currentSchema = await worker.getSchema();
																const currentDatabases = currentSchema?.cluster?.databases || [];
																const existingDb = currentDatabases.find((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase());
																const nextDatabases = existingDb
																	? currentDatabases.map((db: any) => db?.name?.toLowerCase?.() === databaseSchema.name.toLowerCase() ? databaseSchema : db)
																	: [...currentDatabases, databaseSchema];
																await worker.setSchema({ ...currentSchema, cluster: { ...(currentSchema?.cluster || {}), databases: nextDatabases }, database: databaseSchema });
															}
														} catch { /* best effort */ }
													}
												}
											} catch (addError) {
												console.error('[monaco-kusto] ADD: addDatabaseToSchema failed:', addError);
											}
										} else if (!alreadyLoadedGlobally) {
											// Fallback: setSchemaFromShowSchema (will replace, but better than nothing)
											if (typeof worker.setSchemaFromShowSchema === 'function') {
												try {
													await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
													__kustoSchemaTracker.recordFirstLoad(modelKey, schemaKey, clusterUrl, databaseInContext, schemaObj);
													__kustoMonacoInitializedByModel[modelKey] = true;
													__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: databaseInContext };
												} catch (e) {
													console.error('[monaco-kusto] Fallback setSchemaFromShowSchema failed:', e);
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
__kustoSetDatabaseInContext = async function (clusterUrl: any, database: any, modelUri = null) {
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
						const currentContext = __kustoMonacoDatabaseInContextByModel?.[modelKey] || __kustoSchemaTracker.databaseInContext;
						
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
							
							__kustoMonacoDatabaseInContextByModel[modelKey] = { clusterUrl, database: targetDatabase.name };
							__kustoSchemaTracker.databaseInContext = __kustoMonacoDatabaseInContextByModel[modelKey];
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
__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true) {
						try {
							if (!boxId) return;
							
							// Debounce: skip if we're already processing this exact box
							if (__kustoFocusInProgress === boxId) {
								return;
							}
							
							__kustoFocusInProgress = boxId;
							
							// Mark worker as initialized once a query box gets focus
							__kustoWorkerInitialized = true;
							
							// If we need to reload schemas after tab became visible, do it now
							if (__kustoWorkerNeedsSchemaReload) {
								__kustoWorkerNeedsSchemaReload = false;
							}
							
							// ── Schema diagnostics: focus switch ──
							try {
								const diagEl = document.getElementById(boxId) as any;
								const diagName = diagEl?.getName ? diagEl.getName() : boxId;
								const diagCluster = diagEl?.getClusterUrl ? diagEl.getClusterUrl() : '(none)';
								const diagDb = diagEl?.getDatabase ? diagEl.getDatabase() : '(none)';
								const diagCtx = __kustoSchemaTracker.databaseInContext;
								console.log(
									'%c[schema-diag] FOCUS → section: %s | cluster: %s | database: %s | current-context: %s/%s',
									'color:#0f0;font-weight:bold',
									diagName, diagCluster, diagDb,
									diagCtx?.clusterUrl || '(none)', diagCtx?.database || '(none)'
								);
							} catch (e) { /* ignore diag errors */ }
							
							// Get the connection and database for this box
							let ownerId = boxId;
							try {
								if (typeof _win.__kustoGetSelectionOwnerBoxId === 'function') {
									ownerId = _win.__kustoGetSelectionOwnerBoxId(boxId) || boxId;
								}
							} catch (e) { console.error('[kusto]', e); }
							
const connectionId = __kustoGetConnectionId(ownerId);
									const database = __kustoGetDatabase(ownerId);
							
							// Only enable markers (red squiggles) if both cluster and database are selected.
							// Without a full connection context, diagnostics would show false positives.
							if (!connectionId || !database) {
								return;
							}
							
							// Enable markers for this editor's model AFTER confirming connection context (lazy diagnostics)
							if (enableMarkers) {
								__kustoEnableMarkersForBox!(boxId);
							}
							
							// Get the cluster URL for this connection
							const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === connectionId) : null;
							const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
							
							if (!clusterUrl) {
								return;
							}
							
							let focusedModelUri: string | null = null;
							// Register model→cluster mapping for marker suppression
							try {
								const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
								if (editor && typeof editor.getModel === 'function') {
									const model = editor.getModel();
									if (model && model.uri) {
										focusedModelUri = model.uri.toString();
										__kustoModelClusterMap[focusedModelUri!] = clusterUrl;
									}
								}
							} catch (e) { console.error('[kusto]', e); }
							
							if (!focusedModelUri) {
								return;
							}
							
							// Get rawSchemaJson from the existing schema cache (schemaByBoxId)
							const schema = typeof schemaByBoxId !== 'undefined' ? schemaByBoxId[boxId] : null;
							const rawSchemaJson = schema && schema.rawSchemaJson ? schema.rawSchemaJson : null;
							
							if (rawSchemaJson) {
								// Delegate to the queued schema loader with setAsContext=true.
								// This ensures all schema operations are serialized and tracking
								// state (global + per-model) is properly updated. The queued
								// function handles first-load vs add vs replace logic correctly,
								// including the "already loaded, just switch context" optimization.
								await _win.__kustoSetMonacoKustoSchema(rawSchemaJson, clusterUrl, database, true, focusedModelUri);
								
								// Trigger re-validation with the newly loaded schema
								__kustoTriggerRevalidation!(boxId);
							} else {
								// No rawSchemaJson in schemaByBoxId yet. Check if the schema
								// was previously loaded and cached in __kustoSchemaTracker.schemaCache.
								const schemaKey = `${clusterUrl}|${database}`;
								const cachedSchema = __kustoSchemaTracker.schemaCache[schemaKey];
								if (cachedSchema && cachedSchema.rawSchemaJson) {
									await _win.__kustoSetMonacoKustoSchema(cachedSchema.rawSchemaJson, clusterUrl, database, true, focusedModelUri);
									__kustoTriggerRevalidation!(boxId);
								} else {
									// No cached schema anywhere — trigger a schema fetch.
									// When the schema arrives via 'schemaData' message, the handler
									// will call __kustoSetMonacoKustoSchema.
									if (typeof ensureSchemaForBox === 'function') {
										ensureSchemaForBox(boxId, true);
									}
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Error updating schema for focused box:', e);
						} finally {
							if (__kustoFocusInProgress === boxId) {
								__kustoFocusInProgress = null;
							}
						}
					};
					
					// Helper to enable markers for a specific box's editor
__kustoEnableMarkersForBox = function(boxId: any) {
						try {
							const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
							if (editor && typeof editor.getModel === 'function') {
								const model = editor.getModel();
								if (model && model.uri) {
									if (__kustoEnableMarkersForModel != null) {
										__kustoEnableMarkersForModel!(model.uri);
									}
								}
							}
						} catch (e) { console.error('[kusto]', e); }
					};
					
					// Helper to trigger re-validation for a specific box's editor
					// This is needed after context switch since monaco-kusto doesn't auto-revalidate
__kustoTriggerRevalidation = function(boxId: any) {
						try {
							const editor = typeof queryEditors !== 'undefined' ? queryEditors[boxId] : null;
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
					__kustoCrossClusterSchemas = {};

					// Parse query text to extract cluster() and database() references
					// Returns array of { clusterName, database } objects
__kustoExtractCrossClusterRefs = function (queryText: any) {
						const refs: any[] = [];
						if (!queryText || typeof queryText !== 'string') {
							return refs;
						}

						// Pattern 1: cluster('name').database('dbname')
						// cluster("name").database("dbname")
						// cluster(name).database(dbname) - without quotes
						const clusterDbPattern = /cluster\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)\s*\.\s*database\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
						// Get current context to skip refs that match the active connection
						const currentCtx = __kustoSchemaTracker.databaseInContext;
						const currentClusterShort = currentCtx?.clusterUrl
							? (currentCtx.clusterUrl.match(/https?:\/\/([^.]+)/i)?.[1] || '').toLowerCase()
							: '';
						const currentDbLower = (currentCtx?.database || '').toLowerCase();
						let match;
						while ((match = clusterDbPattern.exec(queryText)) !== null) {
							const clusterName = match[1];
							const database = match[2];
							if (clusterName && database) {
								// Skip if this ref matches the current connection — it's a no-op,
								// the schema for the active cluster+database is already loaded.
								if (currentClusterShort && currentDbLower &&
									clusterName.toLowerCase() === currentClusterShort &&
									database.toLowerCase() === currentDbLower) {
									continue;
								}
								// Also skip if the ref matches the full cluster URL
								if (currentCtx?.clusterUrl && currentDbLower &&
									clusterName.toLowerCase() === currentCtx.clusterUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') &&
									database.toLowerCase() === currentDbLower) {
									continue;
								}
								// Avoid duplicates
								const exists = refs.some(r => 
									r.clusterName?.toLowerCase() === clusterName.toLowerCase() &&
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
								const currentDb = __kustoSchemaTracker.databaseInContext?.database;
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
__kustoRequestCrossClusterSchema = function (clusterName: any, database: any, boxId: any) {
						// If clusterName is null, resolve it from current context
						let resolvedClusterName = clusterName;
						if (clusterName === null) {
							const currentContext = __kustoSchemaTracker.databaseInContext;
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
						if (__kustoCrossClusterSchemas[key]) {
							return;
						}

						// Mark as pending
						__kustoCrossClusterSchemas[key] = { status: 'pending' };

						const requestToken = 'crosscluster_' + Date.now() + '_' + Math.random().toString(16).slice(2);
						
						postMessageToHost({
							type: 'requestCrossClusterSchema',
							clusterName: resolvedClusterName,
							database,
							boxId: boxId || '',
							requestToken
						});
					};

					// Apply a cross-cluster schema to monaco-kusto
					// This is serialized through the same queue as __kustoSetMonacoKustoSchema to prevent races
					_win.__kustoApplyCrossClusterSchema = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any) {
						// Serialize through the same queue as primary schema operations
						const operationPromise = __kustoSchemaOperationQueue.then(async () => {
							return await __kustoApplyCrossClusterSchemaInternal!(clusterName, clusterUrl, database, rawSchemaJson);
						}).catch((e: any) => {
							console.error('[monaco-kusto] Cross-cluster schema operation failed:', e);
						});
						__kustoSchemaOperationQueue = operationPromise;
						return operationPromise;
					};
					
					// Internal implementation - called through the queue
__kustoApplyCrossClusterSchemaInternal = async function (clusterName: any, clusterUrl: any, database: any, rawSchemaJson: any) {
						const key = `${clusterName.toLowerCase()}|${database.toLowerCase()}`;
						
						try {
							// Parse the raw schema JSON
							let schemaObj;
							if (typeof rawSchemaJson === 'string') {
								try {
									schemaObj = JSON.parse(rawSchemaJson);
								} catch (e) {
									console.error('[monaco-kusto] Failed to parse cross-cluster schema JSON:', e);
									__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Failed to parse schema' };
									return;
								}
							} else {
								schemaObj = rawSchemaJson;
							}

							if (!schemaObj || !schemaObj.Databases) {
								__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Invalid schema format' };
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
															let appliedCount = 0;
															try {
																const syncedModel = models[0];
																const worker2 = await workerAccessor(syncedModel.uri);
																if (worker2 && typeof worker2.addDatabaseToSchema === 'function') {
																	await worker2.addDatabaseToSchema(syncedModel.uri.toString(), clusterName, databaseSchema);
																	appliedCount++;
																}
															} catch (e) { console.error('[kusto]', e); }
															// NOTE: Do NOT update __kustoSchemaTracker.loadedSchemas or
															// __kustoSchemaTracker.loadedSchemasByModel here. Cross-cluster/
															// cross-database schemas added via addDatabaseToSchema are
															// supplementary references only — they must NOT interfere
															// with the primary schema tracking used by needsReplace and
															// the alreadyLoaded logic. If we mark them as loaded, the
															// next focus-switch incorrectly thinks the primary schema
															// is already set and skips the context switch.
												
																if (appliedCount > 0) {
																	__kustoCrossClusterSchemas[key] = { 
																		status: 'loaded', 
																		rawSchemaJson: schemaObj,
																		clusterUrl
																	};
																} else {
																	__kustoCrossClusterSchemas[key] = { status: 'error', error: 'API not available' };
																}
											
											// Show notification to user that cross-cluster schema was loaded
											try {
												postMessageToHost({
													type: 'showInfo',
													message: `Schema loaded for cluster('${clusterName}').database('${database}') — autocomplete is now available.`
												});
											} catch (e) { console.error('[kusto]', e); }
													} else {
														__kustoCrossClusterSchemas[key] = { status: 'error', error: 'Database not found in schema' };
													}
								}
							}
						} catch (e) {
							console.error('[monaco-kusto] Failed to apply cross-cluster schema:', e);
							__kustoCrossClusterSchemas[key] = { status: 'error', error: String(e) };
						}
					};

					// Check for cross-cluster references in a query and request schemas
__kustoCheckCrossClusterRefs = function (queryText: any, boxId: any) {
						const refs = __kustoExtractCrossClusterRefs!(queryText);
						if (refs.length > 0) {
							const diagCtx = __kustoSchemaTracker.databaseInContext;
							console.log(
								'%c[schema-diag] FQ-REFS in %s | current-context: %s/%s | refs:',
								'color:#f80;font-weight:bold',
								boxId,
								diagCtx?.clusterUrl || '(none)', diagCtx?.database || '(none)',
								refs.map(r => `${r.clusterName || '(same-cluster)'}/${r.database}`)
							);
						}
						for (const ref of refs) {
							__kustoRequestCrossClusterSchema!(ref.clusterName, ref.database, boxId);
						}
					};

					// --- Copilot inline completions Provider ---
					// Uses an async provider that awaits the LLM response. The provider
					// intentionally does NOT hook token.onCancellationRequested — Monaco
					// aggressively cancels manual triggers, which would kill the pending
					// request before the response arrives. Instead we let the promise
					// resolve naturally and Monaco renders the items if it's still interested.

					let __kustoInlineCompletionRequestId = 0;
					// Content widget for the inline completion spinner.
					const __kustoInlineSpinnerWidgets: Record<string, any> = {};

					// CSS for the spinner — inject once.
					try {
						const spinnerStyle = document.createElement('style');
						spinnerStyle.textContent = `
							@keyframes kusto-inline-ghost-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
							.kusto-inline-spinner-widget {
								display: inline-flex;
								align-items: center;
								gap: 4px;
								pointer-events: none;
								z-index: 1;
								padding: 0 4px;
								animation: kusto-inline-ghost-pulse 1.2s ease-in-out infinite;
							}
							.kusto-inline-spinner-icon {
								display: inline-block;
								width: 14px;
								height: 14px;
								color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
							}
							.kusto-inline-spinner-icon svg {
								width: 100%;
								height: 100%;
							}
							.kusto-inline-spinner-label {
								font-size: 11px;
								color: var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.7));
								font-style: italic;
								white-space: nowrap;
							}
						`;
						document.head.appendChild(spinnerStyle);
					} catch { /* ignore */ }

					const __kustoShowInlineSpinner = (editor: any, boxId: string, lineNumber: number, column: number) => {
						try {
							__kustoHideInlineSpinner(editor, boxId);
							const domNode = document.createElement('div');
							domNode.className = 'kusto-inline-spinner-widget';
							domNode.innerHTML = '<span class="kusto-inline-spinner-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg></span>';
							const widget = {
								getId: () => 'kusto-inline-spinner-' + boxId,
								getDomNode: () => domNode,
								getPosition: () => ({
									position: { lineNumber, column },
									preference: [2, 1]
								}),
							};
							editor.addContentWidget(widget);
							__kustoInlineSpinnerWidgets[boxId] = widget;
						} catch { /* ignore */ }
					};
					const __kustoHideInlineSpinner = (editor: any, boxId: string) => {
						try {
							const existing = __kustoInlineSpinnerWidgets[boxId];
							if (existing) {
								editor.removeContentWidget(existing);
								delete __kustoInlineSpinnerWidgets[boxId];
							}
						} catch { /* ignore */ }
					};

					// The result handler is still needed for main.ts message dispatch.
					// It resolves the pending promise.
					_win.__kustoHandleInlineCompletionResult = (requestId: string, completions: any[]) => {
						const pending = copilotInlineCompletionRequests[requestId];
						if (!pending || typeof pending.resolve !== 'function') return;
						delete copilotInlineCompletionRequests[requestId];
						pending.resolve(completions || []);
					};

					monaco.languages.registerInlineCompletionsProvider('kusto', {
						provideInlineCompletions: async function (model: any, position: any, context: any, _token: any) {
							try {
								const isManualTrigger = context && context.triggerKind === 1;

								// Check if automatic inline completions are enabled
								if (!isManualTrigger && typeof copilotInlineCompletionsEnabled !== 'undefined' && !copilotInlineCompletionsEnabled) {
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

								// Don't trigger if editor is empty
								if (!textBefore.trim() && !textAfter.trim()) {
									return { items: [] };
								}

								const requestId = 'inline_' + (++__kustoInlineCompletionRequestId) + '_' + Date.now();

								// Find the boxId and editor
								let boxId = '';
								let editorForModel: any = null;
								try {
									const modelUri = model.uri ? model.uri.toString() : '';
									if (typeof queryEditorBoxByModelUri !== 'undefined' && modelUri) {
										boxId = queryEditorBoxByModelUri[modelUri] || '';
									}
									if (boxId && queryEditors) {
										editorForModel = queryEditors[boxId] || null;
									}
								} catch (e) { console.error('[kusto]', e); }

								// Show spinner
								if (editorForModel && boxId) {
									__kustoShowInlineSpinner(editorForModel, boxId, position.lineNumber, position.column);
								}

								// Create promise that resolves when the extension host responds.
								// IMPORTANT: we do NOT hook token.onCancellationRequested — Monaco
								// aggressively cancels especially for manual triggers, which would
								// delete the pending request before the LLM can respond.
								const completionPromise = new Promise<any[]>((resolve) => {
									const timeoutId = setTimeout(() => {
										delete copilotInlineCompletionRequests[requestId];
										resolve([]);
									}, 10000);

									copilotInlineCompletionRequests[requestId] = {
										resolve: (completions: any) => {
											clearTimeout(timeoutId);
											resolve(completions);
										}
									};
								});

								// Send request to extension host
								try {
									postMessageToHost({
										type: 'requestCopilotInlineCompletion',
										requestId,
										boxId,
										textBefore,
										textAfter
									});
								} catch (err) {
									delete copilotInlineCompletionRequests[requestId];
									if (editorForModel && boxId) __kustoHideInlineSpinner(editorForModel, boxId);
									return { items: [] };
								}

								// Await response
								const completions = await completionPromise;

								// Hide spinner
								if (editorForModel && boxId) {
									__kustoHideInlineSpinner(editorForModel, boxId);
								}

								if (!completions || !Array.isArray(completions) || completions.length === 0) {
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
						freeInlineCompletions: function () {
							// No cleanup needed
						}
					});
					
					__kustoWorkerInitialized = true;
					
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
	}));

	// If Monaco init fails, allow retries within the same webview session.
	setMonacoReadyPromise(monacoReadyPromise!.catch((e: any) => {
		setMonacoReadyPromise(null);
		throw e;
	}));

	return monacoReadyPromise;
}

// Lazy loading state tracking
// Monaco+Kusto worker is NOT loaded until user focuses a query box
// This saves memory when files are opened but not actively edited
// __kustoWorkerInitialized and __kustoWorkerNeedsSchemaReload are initialized at module scope.

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
				__kustoWorkerNeedsSchemaReload = true;
				
				// Clear the loaded schemas tracking
				if (__kustoSchemaTracker.loadedSchemas) {
					__kustoSchemaTracker.loadedSchemas = {};
				}
				// Clear per-model tracking too (Monaco model URIs can be reused)
				try { __kustoSchemaTracker.loadedSchemasByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoDatabaseInContextByModel = {}; } catch (e) { console.error('[kusto]', e); }
				try { __kustoMonacoInitializedByModel = {}; } catch (e) { console.error('[kusto]', e); }
				__kustoSchemaTracker.databaseInContext = null;
				
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
	return ensureMonaco()!.then((monaco: any) => {
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
			const existing = queryEditors && queryEditors[boxId] ? queryEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditors[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Ensure flex sizing doesn't allow the editor container to expand with content.
		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// If persistence restore ran before Monaco init, apply the restored wrapper height now.
		// This avoids layout glitches when the Copilot split-pane is installed.
		try {
			const pending = pState.pendingWrapperHeightPxByBoxId && pState.pendingWrapperHeightPxByBoxId[boxId];
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
						if (!pState.manualQueryEditorHeightPxByBoxId || typeof pState.manualQueryEditorHeightPxByBoxId !== 'object') {
							pState.manualQueryEditorHeightPxByBoxId = {};
						}
						pState.manualQueryEditorHeightPxByBoxId[boxId] = Math.round(pending);
					} catch (e) { console.error('[kusto]', e); }
				}
				try { delete pState.pendingWrapperHeightPxByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Avoid calling editor.setValue() during initialization; pass initial value into create()
		// to reduce async timing races in VS Code webviews.
		let initialValue = '';
		try {
			const pending = pState.pendingQueryTextByBoxId && pState.pendingQueryTextByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete pState.pendingQueryTextByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
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
				const esc = escapeHtml(raw);
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
				if (typeof __kustoStatementSeparatorMinBlankLines !== 'number') {
					__kustoStatementSeparatorMinBlankLines = 1;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (typeof __kustoGetStatementBlocksFromModel !== 'function') {
					__kustoGetStatementBlocksFromModel = function (model: any) {
						try {
							if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') return [];
							const minBlankLines = Math.max(1, Number(__kustoStatementSeparatorMinBlankLines) || 1);
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
				if (typeof __kustoIsSeparatorBlankLine !== 'function') {
					__kustoIsSeparatorBlankLine = function (model: any, lineNumber: any) {
						try {
							if (!model || typeof model.getLineContent !== 'function' || typeof model.getLineCount !== 'function') return false;
							const lineCount = Math.max(0, Number(model.getLineCount()) || 0);
							const ln = Number(lineNumber) || 0;
							if (!ln || ln < 1 || ln > lineCount) return false;
							const minBlankLines = Math.max(1, Number(__kustoStatementSeparatorMinBlankLines) || 1);
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
				if (typeof __kustoExtractStatementTextAtCursor !== 'function') {
					__kustoExtractStatementTextAtCursor = function (editor: any) {
						try {
							if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
							const model = editor.getModel();
							const pos = editor.getPosition();
							if (!model || !pos || !pos.lineNumber) return null;
							const cursorLine = Number(pos.lineNumber) || 0;
							if (!cursorLine || cursorLine < 1) return null;
							// If the cursor is on a separator (2+ blank lines), treat as "no statement".
							try {
								if (__kustoIsSeparatorBlankLine && __kustoIsSeparatorBlankLine(model, cursorLine)) {
									return null;
								}
							} catch (e) { console.error('[kusto]', e); }
							const blocks = (__kustoGetStatementBlocksFromModel && typeof __kustoGetStatementBlocksFromModel === 'function')
								? __kustoGetStatementBlocksFromModel(model)
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
					if (__kustoGetStatementBlocksFromModel && typeof __kustoGetStatementBlocksFromModel === 'function') {
						return __kustoGetStatementBlocksFromModel(model);
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
						if (__kustoIsSeparatorBlankLine && __kustoIsSeparatorBlankLine(model, pos.lineNumber)) {
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
			if (!__kustoAutoFindInQueryEditor) {
				__kustoAutoFindInQueryEditor = async (boxId: any, term: any) => {
					const bid = String(boxId || '').trim();
					const t = String(term || '');
					if (!bid || !t) return false;
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
					if (!ed) return false;
					try {
						const state = __kustoAutoFindStateByBoxId[bid];
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
						__kustoAutoFindStateByBoxId[bid] = { term: usedTerm, ts: Date.now() };
					} catch (e) { console.error('[kusto]', e); }
					return true;
				};
				// Retain window bridge for kw-query-section.ts which reads window.__kustoAutoFindInQueryEditor.
				_win.__kustoAutoFindInQueryEditor = __kustoAutoFindInQueryEditor;
			}
			if (typeof _win.__kustoClearAutoFindInQueryEditor !== 'function') {
				_win.__kustoClearAutoFindInQueryEditor = (boxId: any) => {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					let had = false;
					try { had = !!(__kustoAutoFindStateByBoxId[bid]); } catch { had = false; }
					if (!had) return;
					try { delete __kustoAutoFindStateByBoxId[bid]; } catch (e) { console.error('[kusto]', e); }
					const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[bid] : null;
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

		queryEditors[boxId] = editor;
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
				if (typeof autoTriggerAutocompleteEnabled !== 'boolean' || !autoTriggerAutocompleteEnabled) return;
				// Only auto-trigger for the currently focused query editor.
				try {
					if (typeof activeQueryEditorBoxId === 'string' && activeQueryEditorBoxId !== boxId) {
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
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
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
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
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
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
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
						const ed = (typeof queryEditors !== 'undefined' && queryEditors) ? queryEditors[id] : null;
						if (!ed) return;
						let v = ed.getValue ? ed.getValue() : '';
						// When the editor has multiple statements, operate on the statement under the cursor.
						try {
							const model = ed.getModel && ed.getModel();
							const blocks = (model && typeof __kustoGetStatementBlocksFromModel === 'function')
								? __kustoGetStatementBlocksFromModel(model)
								: [];
							const hasMultipleStatements = blocks && blocks.length > 1;
							if (hasMultipleStatements && typeof __kustoExtractStatementTextAtCursor === 'function') {
								const stmt = __kustoExtractStatementTextAtCursor(ed);
								if (stmt) {
									v = stmt;
								} else {
									try { postMessageToHost({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to copy that statement as a single line.' }); } catch (e) { console.error('[kusto]', e); }
									return;
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						const single = __kustoToSingleLineKusto(v);

						// Copy to clipboard without modifying the editor.
						try {
							if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
								await navigator.clipboard.writeText(single);
								try { postMessageToHost({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
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
						try { postMessageToHost({ type: 'showInfo', message: 'Single-line query copied to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
					} catch {
						try { postMessageToHost({ type: 'showInfo', message: 'Failed to copy single-line query to clipboard.' }); } catch (e) { console.error('[kusto]', e); }
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
				console.log('[Kusto] SHIFT+SPACE pressed');
				try {
					// Try the action runner first (more reliable).
					const action = editor.getAction('editor.action.inlineSuggest.trigger');
					if (action) {
						action.run().catch(() => { /* ignore */ });
					} else {
						editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
					}
				} catch (e) {
					console.error('[Kusto] SHIFT+SPACE trigger failed', e);
				}
			});
		} catch (e) { console.error('[kusto]', e); }

		// Ctrl+Enter / Ctrl+Shift+Enter should execute the query (same as the Run button).
		// NOTE: We install this at the Monaco level so Monaco can't consume Ctrl+Shift+Enter before
		// our document-level capture handler runs.
		try {
			const __kustoRunThisQueryBox = () => {
				try {
					executeQuery(boxId);
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
			const escaped = escapeHtml(raw);
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
				if (!__kustoCaretDocsLastHtmlByBoxId || typeof __kustoCaretDocsLastHtmlByBoxId !== 'object') {
					__kustoCaretDocsLastHtmlByBoxId = {};
				}
				const cached = __kustoCaretDocsLastHtmlByBoxId[boxId];
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
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			// In VS Code webviews, document.hasFocus() can be unreliable when the VS Code window
			// loses focus. Track focus explicitly from window-level events.
			try {
				if (typeof __kustoWebviewHasFocus !== 'boolean') {
					__kustoWebviewHasFocus = true;
				}
				if (!__kustoWebviewFocusListenersInstalled) {
					__kustoWebviewFocusListenersInstalled = true;
					try {
						window.addEventListener(
							'blur',
							() => {
								try { __kustoWebviewHasFocus = false; } catch (e) { console.error('[kusto]', e); }
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
					try { window.addEventListener('focus', () => { try { __kustoWebviewHasFocus = true; } catch (e) { console.error('[kusto]', e); } }, true); } catch (e) { console.error('[kusto]', e); }
					try {
						document.addEventListener('visibilitychange', () => {
							try {
								// When the tab becomes hidden, treat as unfocused.
								__kustoWebviewHasFocus = !document.hidden;
							} catch (e) { console.error('[kusto]', e); }
						}, true);
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }

			const isWebviewFocused = () => {
				try {
					if (typeof __kustoWebviewHasFocus === 'boolean') {
						return !!__kustoWebviewHasFocus;
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
						if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
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
									if (typeof __kustoWebviewHasFocus === 'boolean' && __kustoWebviewHasFocus === false) {
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
						const activeId = (typeof activeQueryEditorBoxId !== 'undefined' && activeQueryEditorBoxId)
							? String(activeQueryEditorBoxId)
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

					const getter = __kustoGetHoverInfoAt;
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
									if (__kustoCaretDocsLastHtmlByBoxId && typeof __kustoCaretDocsLastHtmlByBoxId === 'object') {
										__kustoCaretDocsLastHtmlByBoxId[boxId] = html;
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
						if (typeof caretDocOverlaysByBoxId !== 'undefined' && caretDocOverlaysByBoxId) {
							caretDocOverlaysByBoxId[boxId] = docOverlay;
						}
					} catch (e) { console.error('[kusto]', e); }

					// Keep the overlay positioned correctly when the outer webview scrolls/resizes.
					// Install once globally to avoid accumulating listeners per editor.
					try {
						if (!__kustoCaretDocsViewportListenersInstalled) {
							__kustoCaretDocsViewportListenersInstalled = true;
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
							if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
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
				queryEditorBoxByModelUri[model.uri.toString()] = boxId;
			}
		} catch (e) { console.error('[kusto]', e); }

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
		editor.onDidChangeModelContent((e: any) => {
			syncPlaceholder();
			scheduleDocUpdate();
			try {
				if (typeof _win.__kustoOnQueryValueChanged === 'function') {
					_win.__kustoOnQueryValueChanged(boxId, editor.getValue());
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoScheduleKustoDiagnostics(boxId, 250);
			} catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references and request their schemas
			try {
				if (__kustoCheckCrossClusterRefs != null) {
					// Debounce the check to avoid excessive requests while typing
					if (!__kustoCrossClusterCheckTimeout) {
						__kustoCrossClusterCheckTimeout = {};
					}
					clearTimeout(__kustoCrossClusterCheckTimeout[boxId]);
					__kustoCrossClusterCheckTimeout[boxId] = setTimeout(() => {
						__kustoCheckCrossClusterRefs!(editor.getValue(), boxId);
					}, 500);
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoTriggerAutocomplete(editor, boxId, e); } catch (e) { console.error('[kusto]', e); }
		});
		editor.onDidFocusEditorText(() => {
			setActiveQueryEditorBoxId(boxId);
			setActiveMonacoEditor(editor);
			try { __kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
			try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			syncPlaceholder();
			ensureSchemaForBox(boxId);
			scheduleDocUpdate();
			// Update monaco-kusto schema if switching to a different cluster/database
			try {
				if (__kustoUpdateSchemaForFocusedBox != null) {
					__kustoUpdateSchemaForFocusedBox!(boxId);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoScheduleKustoDiagnostics(boxId, 0);
			} catch (e) { console.error('[kusto]', e); }
			// Check for cross-cluster references on focus (in addition to content change)
			try {
				if (__kustoCheckCrossClusterRefs != null) {
					// Small delay to let the schema load first
					setTimeout(() => {
						__kustoCheckCrossClusterRefs!(editor.getValue(), boxId);
					}, 100);
				}
			} catch (e) { console.error('[kusto]', e); }
		});
		// When the suggest widget opens, Monaco may blur the text area while the editor widget
		// still has focus. Track focus at the editor-widget level so our docs widget stays visible.
		try {
			editor.onDidFocusEditorWidget(() => {
				setActiveQueryEditorBoxId(boxId);
				setActiveMonacoEditor(editor);
				try { __kustoLastMonacoInteractionAt = Date.now(); } catch (e) { console.error('[kusto]', e); }
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
								if (typeof caretDocsEnabled !== 'undefined' && caretDocsEnabled === false) {
									docOverlay.hide();
								}
							} catch (e) { console.error('[kusto]', e); }
							if (activeQueryEditorBoxId === boxId) {
								setActiveQueryEditorBoxId(null);
							}
							syncPlaceholder();
							// Keep existing docs banner content visible while unfocused.
							// (The overlay's update loop also freezes while unfocused.)
							
							// Disable markers (red squiggles) for this editor now that it's unfocused
							try {
								const model = editor.getModel();
								if (model && model.uri && __kustoDisableMarkersForModel != null) {
									__kustoDisableMarkersForModel!(model.uri);
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
				setActiveQueryEditorBoxId(boxId);
				setActiveMonacoEditor(editor);
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
						if ((e.target as HTMLElement).closest('.kusto-copilot-chat') || (e.target as HTMLElement).closest('kw-copilot-chat') || (e.target as HTMLElement).closest('[data-kusto-no-editor-focus="true"]')) {
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
			if (queryEditorResizeObservers[boxId]) {
				try { queryEditorResizeObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
			}
			const ro = new ResizeObserver(() => {
				try { editor.layout(); } catch (e) { console.error('[kusto]', e); }
				try { if (typeof editor.__kustoScheduleSuggestClamp === 'function') editor.__kustoScheduleSuggestClamp(); } catch (e) { console.error('[kusto]', e); }
			});
			ro.observe(wrapper);
			queryEditorResizeObservers[boxId] = ro;
		}

		// In multi-editor layouts (e.g. Copilot split panes), editors can be created while hidden.
		// Ensure we relayout when the wrapper becomes visible again so Monaco widgets position correctly.
		try {
			if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers && queryEditorVisibilityObservers[boxId]) {
				try { queryEditorVisibilityObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditorVisibilityObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers && queryEditorVisibilityMutationObservers[boxId]) {
				try { queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { delete queryEditorVisibilityMutationObservers[boxId]; } catch (e) { console.error('[kusto]', e); }
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
				try { if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers) queryEditorVisibilityObservers[boxId] = io; } catch (e) { console.error('[kusto]', e); }
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
				try { if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers) queryEditorVisibilityMutationObservers[boxId] = mo; } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }

		// Initialize toolbar overflow handling (shows "..." button when buttons overflow)
		try {
			initToolbarOverflow(boxId);
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
					if (!pState.manualQueryEditorHeightPxByBoxId || typeof pState.manualQueryEditorHeightPxByBoxId !== 'object') {
						pState.manualQueryEditorHeightPxByBoxId = {};
					}
				} catch (e) { console.error('[kusto]', e); }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + getScrollY();
				const startHeight = w.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						maybeAutoScrollWhileDragging(moveEvent.clientY);
					} catch (e) { console.error('[kusto]', e); }
					const pageY = moveEvent.clientY + getScrollY();
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
						if (pState.manualQueryEditorHeightPxByBoxId && typeof pState.manualQueryEditorHeightPxByBoxId === 'object') {
							pState.manualQueryEditorHeightPxByBoxId[boxId] = Math.round(nextHeight);
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
					try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
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
					__kustoAutoSizeEditor(boxId);
				} catch (e) { console.error('[kusto]', e); }
			});
		}
	}).catch((e: any) => {
		// If Monaco fails to initialize transiently, retry a few times so the editor
		// doesn't get stuck in a non-interactive placeholder state until reopen.
		try {
			if (queryEditors && queryEditors[boxId]) {
				return;
			}
		} catch (e) { console.error('[kusto]', e); }

		let attempt = 0;
		try {
			attempt = (__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
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
window.ensureMonaco = ensureMonaco as any;
window.initQueryEditor = initQueryEditor;

// ── Deferred window bridges ──────────────────────────────────────────────────
// These module-level lets are populated inside the ensureMonaco().then() callback.
// External modules access them via window.__kustoXxx; the bridge is set via
// Object.defineProperty so it always reads the current value of the module-level let.
Object.defineProperty(window, '__kustoUpdateSchemaForFocusedBox', { get: () => __kustoUpdateSchemaForFocusedBox, configurable: true });
Object.defineProperty(window, '__kustoTriggerRevalidation', { get: () => __kustoTriggerRevalidation, configurable: true });
Object.defineProperty(window, '__kustoGetStatementBlocksFromModel', { get: () => __kustoGetStatementBlocksFromModel, configurable: true });
Object.defineProperty(window, '__kustoExtractStatementTextAtCursor', { get: () => __kustoExtractStatementTextAtCursor, configurable: true });
