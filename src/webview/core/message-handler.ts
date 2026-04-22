// Message handler — extracted from main.ts
// Dispatches incoming postMessage from the extension host to the right module.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { buildSchemaInfo } from '../shared/schema-utils';
import { safeRun } from '../shared/safe-run';
import { getResultsState, displayResultForBox, displayResult, displayCancelled } from './results-state';
import { __kustoRenderErrorUx, __kustoDisplayBoxError } from './error-renderer';
import {
	addQueryBox, removeQueryBox, __kustoGetQuerySectionElement, __kustoSetSectionName,
	__kustoGetConnectionId, __kustoGetDatabase,
	updateConnectionSelects, updateDatabaseSelect, onDatabasesError,
	parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes, __kustoTryAutoEnterFavoritesModeForAllBoxes,
	__kustoMaybeDefaultFirstBoxToFavoritesMode, __kustoOnConnectionsUpdated,
	schemaRequestTokenByBoxId,
	addPythonBox, addUrlBox, removePythonBox, removeUrlBox, onPythonResult, onPythonError,
	addHtmlBox, removeHtmlBox,
	addSqlBox, removeSqlBox,
	updateSqlConnectionSelects, updateSqlDatabaseSelect, onSqlDatabasesError,
	__kustoGetSqlSectionElement, sqlBoxes,
	updateSqlFavoritesUiForAllBoxes,
	__kustoGetChartValidationStatus,
} from './section-factory';
import { addMarkdownBox, removeMarkdownBox, __kustoMaximizeMarkdownBox } from '../sections/kw-markdown-section';
import { addChartBox, removeChartBox } from '../sections/kw-chart-section';
import { addTransformationBox, removeTransformationBox } from '../sections/kw-transformation-section';

import {
	updateCaretDocsToggleButtons, updateAutoTriggerAutocompleteToggleButtons,
	updateCopilotInlineCompletionsToggleButtons, setRunMode,
} from '../sections/kw-query-toolbar';
import {
	executeQuery, setQueryExecuting, __kustoSetResultsVisible,
	__kustoSetLinkedOptimizationMode, displayComparisonSummary,
	optimizeQueryWithCopilot, __kustoSetOptimizeInProgress,
	__kustoHideOptimizePromptForBox, __kustoApplyOptimizeQueryOptions,
} from '../sections/query-execution.controller';
import {
	schedulePersist, handleDocumentDataMessage, getKqlxState,
	__kustoSetCompatibilityMode, __kustoApplyDocumentCapabilities,
	__kustoRequestAddSection, __kustoOnQueryResult,
} from './persistence';
import {
	__kustoControlCommandDocCache, __kustoControlCommandDocPending,
	__kustoCrossClusterSchemas,
} from '../monaco/monaco';
import {
	handleStsResponse, handleStsDiagnostics,
} from '../monaco/sql-sts-providers.js';
import {
	activeQueryEditorBoxId,
	connections, setConnections, setLastConnectionId, setLastDatabase,
	kustoFavorites, setKustoFavorites, setLeaveNoTraceClusters,
	setCaretDocsEnabled, setAutoTriggerAutocompleteEnabled,
	setCopilotInlineCompletionsEnabled,
	queryEditors, cachedDatabases, optimizationMetadataByBoxId,
	schemaByConnDb, schemaRequestResolversByBoxId, schemaByBoxId,
	schemaFetchInFlightByBoxId, databasesRequestResolversByBoxId,
	favoritesModeByBoxId,
	sqlConnections, sqlCachedDatabases, setSqlConnections,
	sqlFavorites, setSqlFavorites, sqlFavoritesModeByBoxId,
} from './state';

const _win = window;

// ── Agent-touched helper ─────────────────────────────────────────────────
// Marks a section's kw-section-shell as agent-touched so it shows the
// Copilot icon next to the unsaved-changes accent bar.

function markSectionAgentTouched(sectionId: string): void {
	if (!sectionId) return;
	const el = document.getElementById(sectionId) as any;
	if (!el) return;
	const shell = el.shadowRoot?.querySelector('kw-section-shell');
	if (shell) {
		shell.agentTouched = true;
	}
}

// --- KQL language service bridge & resource URI resolver ---
// --- KQL language service bridge (webview -> extension host) ---
// Used to share a single semantic engine between the webview Monaco editor and VS Code text editors.
// If the bridge is unavailable or times out, callers should fall back to local heuristics.
let __kustoKqlLanguageRequestResolversById: any = {};

// --- Local resource URI resolver (webview -> extension host) ---
// Used to map markdown-relative paths (e.g. ./images/a.png) to webview-safe URIs.
let __kustoResourceUriRequestResolversById: any = {};

try {
	window.__kustoResolveResourceUri = async function (args: any) {
		const p = (args && typeof args.path === 'string') ? String(args.path) : '';
		const baseUri = (args && typeof args.baseUri === 'string') ? String(args.baseUri) : '';
		if (!p || !window.vscode) {
			return null;
		}
		const requestId = 'resuri_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 2000);
			} catch (e) { console.error('[kusto]', e); }

			__kustoResourceUriRequestResolversById[requestId] = {
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'resolveResourceUri',
					requestId,
					path: p,
					baseUri
				});
			} catch {
				try { delete __kustoResourceUriRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

try {
	window.__kustoRequestKqlTableReferences = async function (args: any) {
		const text = (args && typeof args.text === 'string') ? args.text : '';
		const connectionId = (args && typeof args.connectionId === 'string') ? args.connectionId : '';
		const database = (args && typeof args.database === 'string') ? args.database : '';
		const boxId = (args && typeof args.boxId === 'string') ? args.boxId : '';
		if (!window.vscode) {
			return null;
		}
		const requestId = 'kqlreq_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		return await new Promise((resolve: any) => {
			let timer: any = null;
			try {
				timer = setTimeout(() => {
					try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
					resolve(null);
				}, 1500);
			} catch (e) { console.error('[kusto]', e); }

			__kustoKqlLanguageRequestResolversById[requestId] = {
				resolve: (result: any) => {
					try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
					resolve(result);
				}
			};

			try {
				postMessageToHost({
					type: 'kqlLanguageRequest',
					requestId,
					method: 'kusto/findTableReferences',
					params: { text, connectionId, database, boxId }
				});
			} catch {
				try { delete __kustoKqlLanguageRequestResolversById[requestId]; } catch (e) { console.error('[kusto]', e); }
				try { if (timer) clearTimeout(timer); } catch (e) { console.error('[kusto]', e); }
				resolve(null);
			}
		});
	};
} catch (e) { console.error('[kusto]', e); }

// --- Extension host message dispatcher ---
window.addEventListener('message', async (event: any) => {
	const message = (event && event.data && typeof event.data === 'object') ? event.data : {};
	const messageType = String(message.type || '');
	switch (messageType) {
		case 'settingsUpdate':
			try {
				const altColor = typeof message.alternatingRowColor === 'string' ? message.alternatingRowColor : '';
				if (altColor === 'off') {
					document.documentElement.style.removeProperty('--kw-alt-row-bg');
				} else if (altColor === 'theme' || !altColor) {
					document.documentElement.style.setProperty('--kw-alt-row-bg', 'color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%)');
				} else {
					document.documentElement.style.setProperty('--kw-alt-row-bg', altColor);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'controlCommandSyntaxResult':
			try {
				const commandLower = String(message.commandLower || '').trim();
				if (commandLower) {
					try {
						const ok = !!message.ok;
						const syntax = ok && typeof message.syntax === 'string' ? String(message.syntax) : '';
						const withArgs = ok && Array.isArray(message.withArgs) ? message.withArgs.map((s: any) => String(s)) : [];
						__kustoControlCommandDocCache[commandLower] = {
							syntax,
							withArgs,
							fetchedAt: Date.now()
						};
					} catch (e) { console.error('[kusto]', e); }
					try {
						delete __kustoControlCommandDocPending[commandLower];
					} catch (e) { console.error('[kusto]', e); }
					try {
						if (typeof window.__kustoRefreshActiveCaretDocs === 'function') {
							window.__kustoRefreshActiveCaretDocs();
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'ensureComparisonBox':
			try {
				const boxId = String(message.boxId || '');
				const requestId = String(message.requestId || '');
				const query = (typeof message.query === 'string') ? message.query : '';
				if (!boxId || !requestId) {
					break;
				}
				let comparisonBoxId = '';
				try {
					comparisonBoxId = await optimizeQueryWithCopilot(boxId, query, { skipExecute: true });
				} catch (e) { console.error('[kusto]', e); }
				try {
					postMessageToHost({
						type: 'comparisonBoxEnsured',
						requestId,
						sourceBoxId: boxId,
						comparisonBoxId: String(comparisonBoxId || '')
					});
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'persistenceMode':
				try {
					pState.isSessionFile = !!message.isSessionFile;
					try {
						if (typeof message.documentUri === 'string') {
							pState.documentUri = String(message.documentUri);
						}
					} catch (e) { console.error('[kusto]', e); }
						try {
							if (typeof message.documentKind === 'string') {
								pState.documentKind = String(message.documentKind);
								try {
									if (document && document.body && document.body.dataset) {
										document.body.dataset.kustoDocumentKind = String(message.documentKind);
									}
								} catch (e) { console.error('[kusto]', e); }
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							if (Array.isArray(message.allowedSectionKinds)) {
								pState.allowedSectionKinds = message.allowedSectionKinds.map((k: any) => String(k));
							}
							if (typeof message.defaultSectionKind === 'string') {
								pState.defaultSectionKind = String(message.defaultSectionKind);
							}
							if (typeof message.compatibilitySingleKind === 'string') {
								pState.compatibilitySingleKind = String(message.compatibilitySingleKind);
							}
							if (typeof message.upgradeRequestType === 'string') {
								pState.upgradeRequestType = String(message.upgradeRequestType);
							}
							if (typeof message.compatibilityTooltip === 'string') {
								pState.compatibilityTooltip = String(message.compatibilityTooltip);
							}
							if (typeof message.firstSectionPinned === 'boolean') {
								pState.firstSectionPinned = message.firstSectionPinned;
							}
						} catch (e) { console.error('[kusto]', e); }
						__kustoSetCompatibilityMode(!!message.compatibilityMode);
						try {
							__kustoApplyDocumentCapabilities();
						} catch (e) { console.error('[kusto]', e); }
				} catch (e) { console.error('[kusto]', e); }
				break;
		case 'upgradedToKqlx':
			// The extension host has upgraded the file format from .kql/.csl to .kqlx.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'enabledKqlxSidecar':
			// The extension host has enabled a companion .kqlx metadata file for a .kql/.csl document.
			// Exit compatibility mode and perform the originally-requested add.
			try {
				__kustoSetCompatibilityMode(false);
			} catch (e) { console.error('[kusto]', e); }
			try {
				const k = message && message.addKind ? String(message.addKind) : '';
				if (k) {
					__kustoRequestAddSection(k);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'connectionsData':
			setConnections(message.connections);
			try { window.connections = connections; } catch (e) { console.error('[kusto]', e); }
			setLastConnectionId(message.lastConnectionId);
			setLastDatabase(message.lastDatabase);
			for (const k of Object.keys(cachedDatabases)) delete cachedDatabases[k];
			Object.assign(cachedDatabases, message.cachedDatabases || {});
			setKustoFavorites(Array.isArray(message.favorites) ? message.favorites : []);
			setLeaveNoTraceClusters(Array.isArray(message.leaveNoTraceClusters) ? message.leaveNoTraceClusters : []);
			try { window.__kustoDevNotesEnabled = !!message.devNotesEnabled; } catch (e) { console.error('[kusto]', e); }
			try { pState.copilotChatFirstTimeDismissed = !!message.copilotChatFirstTimeDismissed; } catch (e) { console.error('[kusto]', e); }
			setCaretDocsEnabled((typeof message.caretDocsEnabled === 'boolean') ? message.caretDocsEnabled : true);
			setAutoTriggerAutocompleteEnabled((typeof message.autoTriggerAutocompleteEnabled === 'boolean') ? message.autoTriggerAutocompleteEnabled : true);
			setCopilotInlineCompletionsEnabled((typeof message.copilotInlineCompletionsEnabled === 'boolean') ? message.copilotInlineCompletionsEnabled : true);
			try {
				// Indicates whether the user has explicitly chosen a value (on/off) before.
				// When true, document-level restore should not override this global preference.
				window.__kustoCaretDocsEnabledUserSet = !!message.caretDocsEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			try {
				window.__kustoAutoTriggerAutocompleteEnabledUserSet = !!message.autoTriggerAutocompleteEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			try {
				window.__kustoCopilotInlineCompletionsEnabledUserSet = !!message.copilotInlineCompletionsEnabledUserSet;
			} catch (e) { console.error('[kusto]', e); }
			updateConnectionSelects();
			try {
				__kustoUpdateFavoritesUiForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoTryAutoEnterFavoritesModeForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoMaybeDefaultFirstBoxToFavoritesMode();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoOnConnectionsUpdated();
			} catch (e) { console.error('[kusto]', e); }
			try { updateCaretDocsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			try { updateAutoTriggerAutocompleteToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			try { updateCopilotInlineCompletionsToggleButtons(); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'updateDevNotes': {
			// Mutate passthrough dev notes sections from extension host (Copilot / agent tool calls)
			try {
				if (!Array.isArray(pState.devNotesSections)) {
					pState.devNotesSections = [];
				}
				const action = String(message.action || '');
				if (action === 'add') {
					// Ensure a single devnotes section exists
					let dn = pState.devNotesSections.find((s: any) => s && s.type === 'devnotes');
					if (!dn) {
						dn = { type: 'devnotes', id: 'devnotes_' + Date.now(), entries: [] };
						pState.devNotesSections.push(dn);
					}
					if (!Array.isArray(dn.entries)) dn.entries = [];
					// If superseding an existing entry, remove it first
					if (message.supersedes) {
						const sid = String(message.supersedes);
						dn.entries = dn.entries.filter((e: any) => e && String(e.id) !== sid);
					}
					if (message.entry && typeof message.entry === 'object') {
						dn.entries.push(message.entry);
					}
				} else if (action === 'remove') {
					const noteId = String(message.noteId || '');
					if (noteId) {
						for (const dn of pState.devNotesSections) {
							if (dn && Array.isArray(dn.entries)) {
								dn.entries = dn.entries.filter((e: any) => e && String(e.id) !== noteId);
							}
						}
					}
				}
				// Persist after mutation
				try { schedulePersist('devnotes-update'); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			// Respond to extension host if a requestId was provided
			try {
				if (message.requestId) {
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: true } });
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		}
		case 'favoritesData':
			setKustoFavorites(Array.isArray(message.favorites) ? message.favorites : []);
			try {
				__kustoUpdateFavoritesUiForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoTryAutoEnterFavoritesModeForAllBoxes();
			} catch (e) { console.error('[kusto]', e); }
			try {
				__kustoMaybeDefaultFirstBoxToFavoritesMode();
			} catch (e) { console.error('[kusto]', e); }
			// If this update came from an "Add favorite" action in a specific box, automatically
			// switch that box into Favorites mode.
			try {
				const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
				if (boxId && Array.isArray(kustoFavorites) && kustoFavorites.length > 0) {
					if (typeof window.__kustoEnterFavoritesModeForBox === 'function') {
						window.__kustoEnterFavoritesModeForBox(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'confirmRemoveFavoriteResult':
			try {
				if (typeof window.__kustoOnConfirmRemoveFavoriteResult === 'function') {
					window.__kustoOnConfirmRemoveFavoriteResult(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'documentData':
			try {
				{
					handleDocumentDataMessage(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'revealTextRange':
			try {
				try {
					const s = message && message.start ? message.start : null;
					const e = message && message.end ? message.end : null;
					const sl = s && typeof s.line === 'number' ? s.line : 0;
					const sc = s && typeof s.character === 'number' ? s.character : 0;
					const el = e && typeof e.line === 'number' ? e.line : sl;
					const ec = e && typeof e.character === 'number' ? e.character : sc;
					const matchLen = (message && typeof message.matchText === 'string') ? String(message.matchText).length : 0;
					postMessageToHost({
						type: 'debugMdSearchReveal',
						phase: 'revealTextRange(received)',
						detail: `${String(message.documentUri || '')} ${sl}:${sc}-${el}:${ec} matchLen=${matchLen}`
					});
				} catch (e) { console.error('[kusto]', e); }
				if (typeof window.__kustoRevealTextRangeFromHost === 'function') {
					window.__kustoRevealTextRangeFromHost(message);
					try {
						postMessageToHost({
							type: 'debugMdSearchReveal',
							phase: 'revealTextRange(dispatched)',
							detail: `${String(message.documentUri || '')}`
						});
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'resolveResourceUriResult':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoResourceUriRequestResolversById && __kustoResourceUriRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					const uri = (message && message.ok && typeof message.uri === 'string') ? String(message.uri) : null;
					try { r.resolve(uri); } catch (e) { console.error('[kusto]', e); }
					try { delete __kustoResourceUriRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'kqlLanguageResponse':
			try {
				const reqId = String(message.requestId || '');
				const r = __kustoKqlLanguageRequestResolversById && __kustoKqlLanguageRequestResolversById[reqId];
				if (r && typeof r.resolve === 'function') {
					try {
						r.resolve(message.ok ? (message.result || null) : null);
					} catch (e) { console.error('[kusto]', e); }
					try { delete __kustoKqlLanguageRequestResolversById[reqId]; } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
					const list = (Array.isArray(message.databases) ? message.databases : [])
						.map((d: any) => String(d || '').trim())
						.filter(Boolean)
						.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));
					try {
						if (cid) {
							let clusterKey = '';
							try {
								const conn = Array.isArray(connections) ? connections.find((c: any) => c && String(c.id || '').trim() === String(cid || '').trim()) : null;
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
							} catch (e) { console.error('[kusto]', e); }
							if (clusterKey) {
								cachedDatabases[clusterKey] = list;
							}
						}
					} catch (e) { console.error('[kusto]', e); }
					try { r.resolve(list); } catch (e) { console.error('[kusto]', e); }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }

			updateDatabaseSelect(message.boxId, message.databases, message.connectionId);
			break;
		case 'databasesError':
			// Reject pending database list request if this was a synthetic request id.
			try {
				const r = databasesRequestResolversByBoxId && databasesRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message && message.error ? String(message.error) : 'Failed to load databases.')); } catch (e) { console.error('[kusto]', e); }
					try { delete databasesRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				onDatabasesError(message.boxId, message && message.error ? String(message.error) : 'Failed to load databases.', message.connectionId);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'importConnectionsXmlText':
			try {
				const text = (typeof message.text === 'string') ? message.text : '';
				const imported = parseKustoExplorerConnectionsXml(text);
				if (!imported || !imported.length) {
					try { postMessageToHost({ type: 'showInfo', message: 'No connections found in the selected XML file.' }); } catch (e) { console.error('[kusto]', e); }
					break;
				}
				postMessageToHost({ type: 'importConnectionsFromXml', connections: imported, boxId: message.boxId });
			} catch (e: any) {
				try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (e && e.message ? e.message : String(e)) }); } catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'importConnectionsXmlError':
			try { postMessageToHost({ type: 'showInfo', message: 'Failed to import connections: ' + (message && message.error ? String(message.error) : 'Unknown error') }); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'queryResult':
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Always target the concrete boxId when available (prevents races when
				// multiple queries are running and keeps comparison summaries in sync).
				if (message.boxId) {
					try {
						setQueryExecuting(message.boxId, false);
					} catch (e) { console.error('[kusto]', e); }
					displayResultForBox(message.result, message.boxId, { label: 'Results', showExecutionTime: true });
				} else {
					displayResult(message.result);
				}
			} catch (e: any) {
				console.error('Failed to render query results:', e);
			}
			try {
				if (message.boxId) {
					__kustoOnQueryResult(message.boxId, message.result);
				}
			} catch (e) { console.error('[kusto]', e); }
			// Check if this is a comparison box result
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId]) {
					const metadata = optimizationMetadataByBoxId[message.boxId];
					if (metadata.isComparison && metadata.sourceBoxId) {
						// Check if source box has results too
						const sourceState = getResultsState(metadata.sourceBoxId);
						const comparisonState = getResultsState(message.boxId);
						if (sourceState && comparisonState) {
							displayComparisonSummary(metadata.sourceBoxId, message.boxId);
						}
					}
				}
			} catch (err: any) {
				console.error('Error displaying comparison summary:', err);
			}
			// Also handle the inverse: source box result arrives after comparison
			try {
				if (message.boxId && optimizationMetadataByBoxId[message.boxId] && optimizationMetadataByBoxId[message.boxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[message.boxId].comparisonBoxId;
					const sourceState = getResultsState(message.boxId);
					const comparisonState = getResultsState(comparisonBoxId);
					if (sourceState && comparisonState) {
						displayComparisonSummary(message.boxId, comparisonBoxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'queryError':
			try {
				if (message && message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				const err = (message && 'error' in message) ? message.error : 'Query execution failed.';
				try {
					if (boxId) {
						setQueryExecuting(boxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				if (boxId) {
					const clientActivityId = (message && typeof message.clientActivityId === 'string') ? message.clientActivityId : undefined;
					__kustoRenderErrorUx(boxId, err, clientActivityId);
				} else {
					console.error('Query error (no error renderer available):', err);
				}
			} catch (e: any) {
				console.error('Failed to render query error:', e);
			}
			break;
		case 'queryCancelled':
			try {
				if (message.boxId) {
					pState.lastExecutedBox = message.boxId;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				const cancelledBoxId = (message && message.boxId) ? String(message.boxId) : (pState.lastExecutedBox ? String(pState.lastExecutedBox) : '');
				if (cancelledBoxId) {
					setQueryExecuting(cancelledBoxId, false);
				}
			} catch (e) { console.error('[kusto]', e); }
			displayCancelled();
			break;
		case 'ensureResultsVisible':
			try {
				const boxId = (message && message.boxId) ? String(message.boxId) : '';
				if (boxId) {
					__kustoSetResultsVisible(boxId, true);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonResult':
			try { onPythonResult(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'pythonError':
			try { onPythonError(message); } catch (e) { console.error('[kusto]', e); }
			break;
		case 'urlContent':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'urlError':
			// Handled by <kw-url-section> Lit component via window message listener.
			break;
		case 'schemaData':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			
			try {
				const cid = String(message.connectionId || '').trim();
				const db = String(message.database || '').trim();
				if (cid && db) {
					schemaByConnDb[cid + '|' + db] = message.schema;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.resolve === 'function') {
					try { r.resolve(message.schema); } catch (e) { console.error('[kusto]', e); }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Normal per-editor schema update (autocomplete).
			// This is the SINGLE source of truth for schema data - no duplicate caching
			schemaByBoxId[message.boxId] = message.schema;
			schemaFetchInFlightByBoxId[message.boxId] = false;
			
			// Update monaco-kusto with the raw schema JSON if available
			// With aggregate schema approach, we always push schemas to monaco-kusto
			// The __kustoSetMonacoKustoSchema function handles de-duplication and uses addDatabaseToSchema for subsequent loads
			try {
				const schemaKey = message.clusterUrl && message.database ? `${message.clusterUrl}|${message.database}` : null;
				
				// Check if this box is the active/focused box - if so, we should set it as the context
				const isActiveBox = message.boxId === activeQueryEditorBoxId;
				const isForceRefresh = !!(message.schemaMeta && message.schemaMeta.forceRefresh);

				// When no editor has focus, skip pushing to the monaco-kusto worker.
				// Schema data is already cached in schemaByBoxId above. When the user
				// focuses a section, __kustoUpdateSchemaForFocusedBox will read from
				// cache and push to the worker queue as the first operation — ensuring
				// the correct database is in context immediately without queueing behind
				// a flood of ADD operations from other sections' responses.
				const shouldUpdate = schemaKey && message.schema && message.schema.rawSchemaJson && message.clusterUrl && message.database
					&& (isActiveBox || isForceRefresh);
				
				if (shouldUpdate) {
					const applySchema = async () => {
						if (typeof window.__kustoSetMonacoKustoSchema === 'function') {
							// Schema/context state in monaco-kusto is tracked PER Monaco model URI.
							// If we don't pass the model URI, monaco.js falls back to models[0], which can
							// immediately put the wrong database in context for the active editor.
							let modelUri: any = null;
							try {
								const editor = queryEditors ? queryEditors[message.boxId] : null;
								const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
								if (model && model.uri) {
									modelUri = model.uri.toString();
								}
							} catch (e) { console.error('[kusto]', e); }

							// If we can't resolve a model URI yet (editor not ready), retry later.
							if (!modelUri) {
								return false;
							}

							// Set as context if this is the active box, OR if this is a force-refresh.
							// When the user clicks "Refresh schema" (forceRefresh), the editor may have lost
							// focus (activeQueryEditorBoxId cleared to null by onDidBlurEditorWidget).
							// Without setAsContext=true, addDatabaseToSchema updates the aggregate schema
							// but the stale in-context database persists, causing completions to stay stale.
							const shouldSetAsContext = isActiveBox || isForceRefresh;
							await window.__kustoSetMonacoKustoSchema(message.schema.rawSchemaJson, message.clusterUrl, message.database, shouldSetAsContext, modelUri, isForceRefresh);
							
							// Trigger revalidation to reflect the new schema
							if (shouldSetAsContext && typeof window.__kustoTriggerRevalidation === 'function') {
								window.__kustoTriggerRevalidation(message.boxId);
							}
							return true;
						}
						return false;
					};
					
					// Try immediately
					applySchema().then((success: any) => {
						if (!success) {
							// If function not available yet, retry after monaco-kusto loads
							const retryDelays = [100, 300, 600, 1000, 2000];
							let retryIndex = 0;
							const retry = () => {
								if (retryIndex < retryDelays.length) {
									setTimeout(() => {
										applySchema().then((applied: any) => {
											if (!applied) {
												retryIndex++;
												retry();
											}
										});
									}, retryDelays[retryIndex]);
								}
							};
							retry();
						}
					});
				}
			} catch (e: any) { console.error('[schemaData] Error:', e); }
			
			// NOTE: Custom diagnostics are disabled - monaco-kusto handles validation
			// try {
			// 	if (typeof window.__kustoScheduleKustoDiagnostics === 'function') {
			// 		window.__kustoScheduleKustoDiagnostics(message.boxId, 0);
			// 	}
			// } catch (e) { console.error('[kusto]', e); }
			{
				const meta = message.schemaMeta || {};
				const tablesCount = meta.tablesCount ?? (message.schema?.tables?.length ?? 0);
				const columnsCount = meta.columnsCount ?? 0;
				const functionsCount = meta.functionsCount ?? (message.schema?.functions?.length ?? 0);
				const hasRawSchemaJson = !!(message.schema && message.schema.rawSchemaJson);
				const isFailoverToCache = !!meta.isFailoverToCache;
				
				// Determine display text and error state based on schema completeness
				let displayText = tablesCount + ' tables, ' + columnsCount + ' cols';
				let tooltipText = 'Schema loaded for autocomplete';
				let isError = false;
				
				if (meta.fromCache) {
					if (isFailoverToCache && !hasRawSchemaJson) {
						// Cached schema from failover but missing rawSchemaJson - autocomplete won't work
						displayText = 'Schema outdated';
						tooltipText = 'Cached schema is outdated. Autocomplete may not work. Try refreshing schema when connected.';
						isError = true;
					} else if (isFailoverToCache) {
						// Cached schema from failover with rawSchemaJson - works but stale
						displayText += ' (cached)';
						tooltipText = 'Using cached schema after connection failure. Schema may be outdated.';
						// Not an error since autocomplete still works
					} else {
						// Normal cache hit
						displayText += ' (cached)';
						tooltipText += ' (cached)';
					}
				}
				
				try {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo(displayText, isError,
							{ fromCache: !!meta.fromCache, tablesCount, columnsCount, functionsCount, hasRawSchemaJson, isFailoverToCache }));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		case 'schemaError':
			// Drop late responses from older selections (e.g., user switched favorites quickly).
			try {
				const tok = message && typeof message.requestToken === 'string' ? message.requestToken : '';
				if (tok && schemaRequestTokenByBoxId) {
					const expected = schemaRequestTokenByBoxId[message.boxId];
					if (expected && expected !== tok) {
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			// Resolve pending schema request if this was a synthetic request id.
			try {
				const r = schemaRequestResolversByBoxId && schemaRequestResolversByBoxId[message.boxId];
				if (r && typeof r.reject === 'function') {
					try { r.reject(new Error(message.error || 'Schema fetch failed')); } catch (e) { console.error('[kusto]', e); }
					try { delete schemaRequestResolversByBoxId[message.boxId]; } catch (e) { console.error('[kusto]', e); }
					break;
				}
			} catch (e) { console.error('[kusto]', e); }
			// Non-fatal; keep any previously loaded schema + counts if present.
			schemaFetchInFlightByBoxId[message.boxId] = false;
			try {
				const hasSchema = !!(schemaByBoxId && schemaByBoxId[message.boxId]);
				if (!hasSchema) {
					const kwEl = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
						kwEl.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				}
			} catch {
				try {
					const kwEl2 = __kustoGetQuerySectionElement(message.boxId);
					if (kwEl2 && typeof kwEl2.setSchemaInfo === 'function') {
						kwEl2.setSchemaInfo(buildSchemaInfo('Schema failed', true));
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			try {
				__kustoDisplayBoxError(message.boxId, message.error || 'Schema fetch failed');
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'crossClusterSchemaData':
			// Handle cross-cluster schema response
			try {
				const clusterName = message.clusterName;
				const clusterUrl = message.clusterUrl;
				const database = message.database;
				const rawSchemaJson = message.rawSchemaJson;
				
				if (rawSchemaJson && typeof window.__kustoApplyCrossClusterSchema === 'function') {
					window.__kustoApplyCrossClusterSchema(clusterName, clusterUrl, database, rawSchemaJson);
				}
			} catch (e: any) {
				console.error('[crossClusterSchemaData] Error:', e);
			}
			break;
		case 'crossClusterSchemaError':
			// Handle cross-cluster schema error
			try {
				const clusterName = message.clusterName;
				const database = message.database;
				const key = `${clusterName.toLowerCase()}|${database.toLowerCase()}`;
				
				// Mark as error so we don't keep retrying
				__kustoCrossClusterSchemas[key] = { status: 'error', error: message.error };
			} catch (e) { console.error('[kusto]', e); }
			break;
			case 'connectionAdded':
				// Refresh list and preselect the new connection in the originating box.
				if (Array.isArray(message.connections)) {
					setConnections(message.connections);
					try { window.connections = connections; } catch (e) { console.error('[kusto]', e); }
				}
				if (message.lastConnectionId) {
					setLastConnectionId(message.lastConnectionId);
				}
				if (typeof message.lastDatabase === 'string') {
					setLastDatabase(message.lastDatabase);
				}
				updateConnectionSelects();
				try {
					__kustoOnConnectionsUpdated();
				} catch (e) { console.error('[kusto]', e); }
				try {
					const boxId = message.boxId || null;
					if (boxId && message.connectionId) {
						const kwEl = __kustoGetQuerySectionElement(boxId);
						if (kwEl && typeof kwEl.setConnectionId === 'function') {
							kwEl.setConnectionId(message.connectionId);
							kwEl.dispatchEvent(new CustomEvent('connection-changed', {
								detail: { boxId: boxId, connectionId: message.connectionId },
								bubbles: true, composed: true,
							}));
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				break;
		// ── SQL connection messages ────────────────────────────────────
		case 'sqlConnectionsData':
			try {
				setSqlConnections(Array.isArray(message.connections) ? message.connections : []);
				for (const k of Object.keys(sqlCachedDatabases)) delete sqlCachedDatabases[k];
				Object.assign(sqlCachedDatabases, message.cachedDatabases || {});
				try { (window as any).__kustoSqlLastConnectionId = message.lastConnectionId || ''; } catch (e) { console.error('[kusto]', e); }
				try { (window as any).__kustoSqlLastDatabase = message.lastDatabase || ''; } catch (e) { console.error('[kusto]', e); }
				setSqlFavorites(Array.isArray(message.sqlFavorites) ? message.sqlFavorites : []);
				updateSqlConnectionSelects();
				try { updateSqlFavoritesUiForAllBoxes(); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlFavoritesData':
			try {
				setSqlFavorites(Array.isArray(message.favorites) ? message.favorites : []);
				try { updateSqlFavoritesUiForAllBoxes(); } catch (e) { console.error('[kusto]', e); }
				try {
					const boxId = message && typeof message.boxId === 'string' ? message.boxId : '';
					if (boxId && Array.isArray(sqlFavorites) && sqlFavorites.length > 0) {
						const sqlEl = __kustoGetSqlSectionElement(boxId);
						if (sqlEl && typeof sqlEl.setFavoritesMode === 'function') {
							sqlEl.setFavoritesMode(true);
							if (typeof sqlFavoritesModeByBoxId === 'object') {
								sqlFavoritesModeByBoxId[boxId] = true;
							}
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlDatabasesData':
			try {
				updateSqlDatabaseSelect(message.boxId, message.databases, message.sqlConnectionId);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlDatabasesError':
			try {
				onSqlDatabasesError(message.boxId, message.error, message.sqlConnectionId);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlConnectionAdded':
			try {
				if (Array.isArray(message.connections)) {
					setSqlConnections(message.connections);
				}
				updateSqlConnectionSelects();
				const boxId = message.boxId || null;
				if (boxId && message.connectionId) {
					const sqlEl = __kustoGetSqlSectionElement(boxId);
					if (sqlEl && typeof sqlEl.setSqlConnectionId === 'function') {
						sqlEl.setSqlConnectionId(message.connectionId);
						sqlEl.dispatchEvent(new CustomEvent('sql-connection-changed', {
							detail: { boxId: boxId, connectionId: message.connectionId },
							bubbles: true, composed: true,
						}));
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'sqlSchemaData':
			try {
				const bid = String(message.boxId || '').trim();
				if (!bid) break;
				const meta = message.schemaMeta || {};
				if (meta.error) {
					// Schema fetch failed
					const sqlEl = __kustoGetSqlSectionElement(bid);
					if (sqlEl && typeof sqlEl.setSchemaInfo === 'function') {
						sqlEl.setSchemaInfo(buildSchemaInfo(meta.errorMessage || 'Schema failed', true));
					}
				} else if (message.schema) {
					// Store schema for autocomplete
					schemaByBoxId[bid] = message.schema;
					const tablesCount = meta.tablesCount ?? (message.schema.tables?.length ?? 0);
					let columnsCount = meta.columnsCount ?? 0;
					if (!columnsCount && message.schema.columnsByTable) {
						for (const tbl of Object.keys(message.schema.columnsByTable)) {
							columnsCount += Object.keys(message.schema.columnsByTable[tbl] || {}).length;
						}
					}
					const fromCache = !!meta.fromCache;
					const displayText = tablesCount + ' tables, ' + columnsCount + ' cols' + (fromCache ? ' (cached)' : '');
					const sqlEl = __kustoGetSqlSectionElement(bid);
					if (sqlEl && typeof sqlEl.setSchemaInfo === 'function') {
						sqlEl.setSchemaInfo(buildSchemaInfo(displayText, false,
							{ fromCache, tablesCount, columnsCount, functionsCount: 0 }));
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'stsResponse':
			try {
				const reqId = String(message.requestId || '');
				handleStsResponse(reqId, message.result);
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'stsDiagnostics':
			try {
				const bid = String(message.boxId || '').trim();
				if (bid) {
					// Suppress diagnostics until STS schema is loaded (_stsReady).
					// Before intelliSenseReady, STS doesn't know about schema objects
					// and produces false "Incorrect syntax" errors for valid table names.
					const diagSqlEl = __kustoGetSqlSectionElement(bid);
					if (diagSqlEl && diagSqlEl._stsReady) {
						handleStsDiagnostics(bid, message.markers || []);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'stsConnectionState':
			try {
				const bid = String(message.boxId || '').trim();
				if (!bid) break;
				const sqlEl = __kustoGetSqlSectionElement(bid);
				if (sqlEl && typeof sqlEl.setStsReady === 'function') {
					sqlEl.setStsReady(String(message.state || '') === 'ready');
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotChatFirstTimeResult':
			try {
				// Update local flag so the dialog is never shown again.
				pState.copilotChatFirstTimeDismissed = true;
				const action = String(message.action || '');
				if (action === 'proceed') {
					// User chose to use the embedded copilot chat; toggle it open.
					const ftBoxId = String(message.boxId || '').trim();
					const kwEl = ftBoxId ? __kustoGetQuerySectionElement(ftBoxId) : null;
					if (kwEl && typeof kwEl.setCopilotChatVisible === 'function') {
						kwEl.setCopilotChatVisible(true);
					} else {
						const sqlEl = ftBoxId ? __kustoGetSqlSectionElement(ftBoxId) : null;
						if (sqlEl && typeof sqlEl.setCopilotChatVisible === 'function') {
							sqlEl.setCopilotChatVisible(true);
						}
					}
				}
				// 'openedAgent' and 'dismissed': do nothing in webview (agent was opened or dialog dismissed).
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotAvailability':
			try {
				const boxId = message.boxId || '';
				const available = !!message.available;
				// Per-editor toolbar toggle button
				try {
					const applyToButton = (btn: any) => {
						if (!btn) return;
						const inProgress = !!(btn.dataset && btn.dataset.kustoCopilotChatInProgress === '1');
						if (!available) {
							btn.disabled = true;
							try { if (btn.dataset) btn.dataset.kustoDisabledByCopilot = '1'; } catch (e) { console.error('[kusto]', e); }
							btn.title = 'Copilot chat\n\nGitHub Copilot is required for this feature. Enable Copilot in VS Code to use Copilot-assisted query writing.';
							btn.setAttribute('aria-disabled', 'true');
						} else {
							const disabledByCopilot = !!(btn.dataset && btn.dataset.kustoDisabledByCopilot === '1');
							if (disabledByCopilot) {
								try { if (btn.dataset) delete btn.dataset.kustoDisabledByCopilot; } catch (e) { console.error('[kusto]', e); }
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
						// Also update all kw-query-toolbar and kw-sql-toolbar Lit elements.
						try {
							document.querySelectorAll('kw-query-toolbar').forEach((toolbar: any) => {
								if (typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
							});
							document.querySelectorAll('kw-sql-toolbar').forEach((toolbar: any) => {
								if (typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
							});
						} catch (e) { console.error('[kusto]', e); }
					} else {
						applyToButton(document.getElementById(boxId + '_copilot_chat_toggle'));
						// Also update the kw-query-toolbar or kw-sql-toolbar Lit element.
						try {
							const toolbar = document.querySelector('kw-query-toolbar[box-id="' + boxId + '"]') as any
								|| document.querySelector('kw-sql-toolbar[box-id="' + boxId + '"]') as any;
							if (toolbar && typeof toolbar.setCopilotChatEnabled === 'function') toolbar.setCopilotChatEnabled(available);
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					// The "Compare two queries" button does not require Copilot.
					try {
						if (optimizeBtn.dataset) {
							delete optimizeBtn.dataset.kustoDisabledByCopilot;
							delete optimizeBtn.dataset.kustoCopilotAvailable;
						}
					} catch (e) { console.error('[kusto]', e); }
					optimizeBtn.title = 'Compare two queries (A vs B) to check if they return the same data and which one is faster to return results';
					optimizeBtn.setAttribute('aria-label', 'Compare two queries (A vs B)');
					// Do not forcibly enable if some other flow disabled it (e.g. query box is removed).
					// Only undo any Copilot-based disabling.
					try {
						if (optimizeBtn.disabled && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeInProgress !== '1') {
							optimizeBtn.disabled = false;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryStatus':
			try {
				const boxId = message.boxId || '';
				const status = message.status || '';
				try {
					__kustoSetOptimizeInProgress(boxId, true, status);
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'compareQueryPerformanceWithQuery':
			try {
				const boxId = String(message.boxId || '');
				const query = String(message.query || '');
				if (boxId) {
					Promise.resolve(optimizeQueryWithCopilot(boxId, query));
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryReady':
			try {
				const sourceBoxId = message.boxId || '';
				try {
					{
						__kustoSetOptimizeInProgress(sourceBoxId, false, '');
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoHideOptimizePromptForBox(sourceBoxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizedQuery = message.optimizedQuery || '';
				let queryName = message.queryName || '';
				// Ensure the source section has a name for optimization.
				// If missing, assign the next unused letter (A, B, C, ...).
				try {
					const nameEl = document.getElementById(sourceBoxId + '_name') as any;
					if (nameEl) {
						let sourceName = String(nameEl.value || '').trim();
						if (!sourceName && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
							sourceName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
							nameEl.value = sourceName;
							try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						}
						if (sourceName) {
							queryName = sourceName;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				// Fallback: if we still don't have a name (e.g. input missing), pick one.
				if (!String(queryName || '').trim() && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
					try {
						queryName = window.__kustoPickNextAvailableSectionLetterName(sourceBoxId);
					} catch (e) { console.error('[kusto]', e); }
				}
				const desiredOptimizedName = String(queryName || '').trim() ? (String(queryName || '').trim() + ' (optimized)') : '';
				const connectionId = message.connectionId || '';
				const database = message.database || '';
				let prettifiedOptimizedQuery = optimizedQuery;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						prettifiedOptimizedQuery = window.__kustoPrettifyKustoText(optimizedQuery);
					}
				} catch (e) { console.error('[kusto]', e); }
				
				// If a comparison box already exists for this source, reuse it.
				if (optimizationMetadataByBoxId[sourceBoxId] && optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId) {
					const comparisonBoxId = optimizationMetadataByBoxId[sourceBoxId].comparisonBoxId;
					const comparisonEditor = queryEditors && queryEditors[comparisonBoxId];
					if (comparisonBoxId && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
						try {
							comparisonEditor.setValue(prettifiedOptimizedQuery);
							try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						} catch (e) { console.error('[kusto]', e); }
						// Name the optimized section "<source name> (optimized)".
						try {
							const nameEl = document.getElementById(comparisonBoxId + '_name') as any;
							if (nameEl) {
								if (desiredOptimizedName) {
									nameEl.value = desiredOptimizedName;
									try { schedulePersist && schedulePersist(); } catch (e) { console.error('[kusto]', e); }
								}
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							optimizationMetadataByBoxId[comparisonBoxId] = optimizationMetadataByBoxId[comparisonBoxId] || {};
							optimizationMetadataByBoxId[comparisonBoxId].sourceBoxId = sourceBoxId;
							optimizationMetadataByBoxId[comparisonBoxId].isComparison = true;
							optimizationMetadataByBoxId[comparisonBoxId].originalQuery = queryEditors[sourceBoxId] ? queryEditors[sourceBoxId].getValue() : '';
							optimizationMetadataByBoxId[comparisonBoxId].optimizedQuery = prettifiedOptimizedQuery;
						} catch (e) { console.error('[kusto]', e); }
						try {
							{
								__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							{
								__kustoSetResultsVisible(sourceBoxId, false);
								__kustoSetResultsVisible(comparisonBoxId, false);
							}
						} catch (e) { console.error('[kusto]', e); }
						try {
							executeQuery(sourceBoxId);
							setTimeout(() => {
								try { executeQuery(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
							}, 100);
						} catch (e) { console.error('[kusto]', e); }
					}

					// Restore the optimize button state on source box
					const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn') as any;
					if (optimizeBtn) {
						optimizeBtn.disabled = false;
						if (optimizeBtn.dataset.originalContent) {
							optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
							delete optimizeBtn.dataset.originalContent;
						}
					}
					break;
				}
				
				// Create a new query box below the source box for comparison
				const comparisonBoxId = addQueryBox({ 
					id: 'query_opt_' + Date.now(), 
					initialQuery: prettifiedOptimizedQuery,
					isComparison: true,
					defaultResultsVisible: false
				});
				try {
					{
						__kustoSetResultsVisible(sourceBoxId, false);
						__kustoSetResultsVisible(comparisonBoxId, false);
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, true);
					}
				} catch (e) { console.error('[kusto]', e); }
				
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
					const sourceBox = document.getElementById(sourceBoxId) as any;
					const comparisonBox = document.getElementById(comparisonBoxId) as any;
					if (sourceBox && comparisonBox && sourceBox.parentNode && comparisonBox.parentNode) {
						sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
					}
					// Scroll the new comparison box into view.
					if (comparisonBox && typeof comparisonBox.scrollIntoView === 'function') {
						comparisonBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
					}
				} catch (e) { console.error('[kusto]', e); }
				
				// Set connection and database to match source
				const compKwEl = __kustoGetQuerySectionElement(comparisonBoxId);
				if (compKwEl) {
					if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
					if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
					compKwEl.dispatchEvent(new CustomEvent('connection-changed', {
						detail: { boxId: comparisonBoxId, connectionId: connectionId },
						bubbles: true, composed: true,
					}));
					setTimeout(() => {
						if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
					}, 100);
					// Carry over favorites mode from source section so the comparison
					// section uses the same connection UI (favorites vs cluster/db dropdowns).
					try {
						const sourceKwEl = __kustoGetQuerySectionElement(sourceBoxId);
						if (sourceKwEl && typeof sourceKwEl.isFavoritesMode === 'function' && sourceKwEl.isFavoritesMode()) {
							if (typeof compKwEl.setFavoritesMode === 'function') compKwEl.setFavoritesMode(true);
							if (typeof favoritesModeByBoxId === 'object') favoritesModeByBoxId[comparisonBoxId] = true;
						}
					} catch (e) { console.error('[kusto]', e); }
				}
				
				// Set the query name
				if (desiredOptimizedName) {
					__kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
				}
				
				// Execute both queries for comparison
				executeQuery(sourceBoxId);
				setTimeout(() => {
					executeQuery(comparisonBoxId);
				}, 100);
				
				// Restore the optimize button state on source box
				const optimizeBtn = document.getElementById(sourceBoxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (err: any) {
				console.error('Error creating comparison box:', err);
			}
			break;
		case 'optimizeQueryOptions':
			try {
				const boxId = message.boxId || '';
				const models = message.models || [];
				const selectedModelId = message.selectedModelId || '';
				const promptText = message.promptText || '';
				{
					__kustoApplyOptimizeQueryOptions(boxId, models, selectedModelId, promptText);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'optimizeQueryError':
			try {
				const boxId = message.boxId || '';
				try {
					{
						__kustoSetOptimizeInProgress(boxId, false, '');
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					{
						__kustoHideOptimizePromptForBox(boxId);
					}
				} catch (e) { console.error('[kusto]', e); }
				const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
				if (optimizeBtn) {
					optimizeBtn.disabled = false;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryOptions':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotApplyWriteQueryOptions === 'function') {
					kwEl.copilotApplyWriteQueryOptions(
						message.models || [],
						message.selectedModelId || '',
						message.tools || []
					);
				} else {
					// Try SQL section
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotApplyWriteQueryOptions === 'function') {
						sqlEl.copilotApplyWriteQueryOptions(
							message.models || [],
							message.selectedModelId || '',
							message.tools || []
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryStatus':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryStatus === 'function') {
					kwEl.copilotWriteQueryStatus(message.status || '', message.detail || '', message.role || '');
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryStatus === 'function') {
						sqlEl.copilotWriteQueryStatus(message.status || '', message.detail || '', message.role || '');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQuerySetQuery':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQuerySetQuery === 'function') {
					kwEl.copilotWriteQuerySetQuery(message.query || '');
					markSectionAgentTouched(boxId);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQuerySetQuery === 'function') {
						sqlEl.copilotWriteQuerySetQuery(message.query || '');
						markSectionAgentTouched(boxId);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryExecuting':
			try {
				const boxId = String(message.boxId || '');
				const executing = !!message.executing;
				if (boxId) {
					setQueryExecuting(boxId, executing);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryToolResult':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryToolResult === 'function') {
					kwEl.copilotWriteQueryToolResult(
						message.tool || '',
						message.label || '',
						message.json || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryToolResult === 'function') {
						sqlEl.copilotWriteQueryToolResult(
							message.tool || '',
							message.label || '',
							message.json || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotExecutedQuery':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendExecutedQuery === 'function') {
					kwEl.copilotAppendExecutedQuery(
						message.query || '',
						message.resultSummary || '',
						message.errorMessage || '',
						message.entryId || '',
						message.result || null
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendExecutedQuery === 'function') {
						sqlEl.copilotAppendExecutedQuery(
							message.query || '',
							message.resultSummary || '',
							message.errorMessage || '',
							message.entryId || '',
							message.result || null
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotGeneralQueryRulesLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendGeneralRulesLink === 'function') {
					kwEl.copilotAppendGeneralRulesLink(
						message.filePath || '',
						message.preview || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendGeneralRulesLink === 'function') {
						sqlEl.copilotAppendGeneralRulesLink(
							message.filePath || '',
							message.preview || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotUserQuerySnapshot':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendQuerySnapshot === 'function') {
					kwEl.copilotAppendQuerySnapshot(
						message.queryText || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendQuerySnapshot === 'function') {
						sqlEl.copilotAppendQuerySnapshot(
							message.queryText || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNotesContextLoaded':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNotesContext === 'function') {
					kwEl.copilotAppendDevNotesContext(
						message.preview || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendDevNotesContext === 'function') {
						sqlEl.copilotAppendDevNotesContext(
							message.preview || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotDevNoteToolCall':
			try {
				const boxId = String(message.boxId || '');
				const detail = message.action === 'save'
					? ('[' + (message.category || 'note') + '] ' + (message.content || ''))
					: ('Removed note: ' + (message.noteId || '') + (message.reason ? ' — ' + message.reason : ''));
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendDevNoteToolCall === 'function') {
					kwEl.copilotAppendDevNoteToolCall(
						message.action || 'save',
						detail,
						message.result || '',
						message.entryId || ''
					);
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendDevNoteToolCall === 'function') {
						sqlEl.copilotAppendDevNoteToolCall(
							message.action || 'save',
							detail,
							message.result || '',
							message.entryId || ''
						);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'revealSection':
			try {
				const boxId = String(message.boxId || '');
				if (boxId) {
					const el = document.getElementById(boxId) as any;
					if (el) {
						if (typeof el.setExpanded === 'function') { el.setExpanded(true); }
						try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotClarifyingQuestion':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotAppendClarifyingQuestion === 'function') {
					kwEl.copilotAppendClarifyingQuestion(
						message.question || '',
						message.entryId || ''
					);
					// Ensure the section is visible so the user can find the question
					if (typeof kwEl.setExpanded === 'function') { kwEl.setExpanded(true); }
					try { kwEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotAppendClarifyingQuestion === 'function') {
						sqlEl.copilotAppendClarifyingQuestion(
							message.question || '',
							message.entryId || ''
						);
						if (typeof sqlEl.setExpanded === 'function') { sqlEl.setExpanded(true); }
						try { sqlEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		case 'copilotWriteQueryDone':
			try {
				const boxId = String(message.boxId || '');
				const kwEl = boxId ? __kustoGetQuerySectionElement(boxId) : null;
				if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
					kwEl.copilotWriteQueryDone(!!message.ok, message.message || '');
				} else {
					const sqlEl = boxId ? __kustoGetSqlSectionElement(boxId) : null;
					if (sqlEl && typeof sqlEl.copilotWriteQueryDone === 'function') {
						sqlEl.copilotWriteQueryDone(!!message.ok, message.message || '');
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'copilotInlineCompletionResult':
			try {
				const requestId = String(message.requestId || '');
				const completions = message.completions || [];
				// Delegate to the handler registered by the inline completions provider.
				// This caches the result and re-triggers the inline suggest action.
				if (typeof _win.__kustoHandleInlineCompletionResult === 'function') {
					_win.__kustoHandleInlineCompletionResult(requestId, completions);
				}
			} catch (err: any) { console.error('[Kusto] Error handling completion result', err); }
			break;
		
		// ─────────────────────────────────────────────────────────────────────────
		// VS Code Copilot Chat Tool Orchestrator Messages
		// ─────────────────────────────────────────────────────────────────────────
		
		case 'requestToolState':
			// Extension is requesting the current sections state
			try {
				const requestId = String(message.requestId || '');
				if (requestId) {
					const state = getKqlxState();
					const sections = (state && state.sections) ? state.sections : [];
					postMessageToHost({ type: 'toolStateResponse', requestId, sections });
				}
			} catch (err: any) {
				console.error('[Kusto Tools] Error getting state:', err);
				try {
					postMessageToHost({ type: 'toolStateResponse', requestId: message.requestId, sections: [] });
				} catch (e) { console.error('[kusto]', e); }
			}
			break;
		
		case 'toolAddSection':
			// Add a new section via tool orchestrator
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionType = String(input.type || '').toLowerCase();
				let sectionId = '';
				let success = false;
				
				try {
					if (sectionType === 'query') {
						const queryOpts: any = {};
						if (input.query) {
							queryOpts.initialQuery = String(input.query);
						}
						sectionId = addQueryBox(queryOpts);
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
						if (sectionId && input.clusterUrl) {
							// Find connection by cluster URL
							const conn = (connections || []).find((c: any) => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
							if (conn) {
								const kwEl = __kustoGetQuerySectionElement(sectionId);
								if (kwEl && typeof kwEl.setConnectionId === 'function') {
									kwEl.setConnectionId(conn.id);
									kwEl.dispatchEvent(new CustomEvent('connection-changed', {
										detail: { boxId: sectionId, connectionId: conn.id, clusterUrl: conn.clusterUrl },
										bubbles: true, composed: true,
									}));
								}
							}
						}
						if (sectionId && input.database) {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.setDatabase === 'function') {
								kwEl.setDatabase(input.database);
								kwEl.dispatchEvent(new CustomEvent('database-changed', {
									detail: { boxId: sectionId, database: input.database },
									bubbles: true, composed: true,
								}));
							}
						}
					} else if (sectionType === 'markdown') {
						// Pass text as option so it's available when the editor initializes
						// Accept both 'text' and 'content' - LLMs may use either property name
						const textValue = input.text ?? input.content;
						const markdownOptions = (textValue !== undefined) ? { text: String(textValue) } : undefined;
						sectionId = addMarkdownBox(markdownOptions);
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'chart') {
						sectionId = addChartBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'transformation') {
						sectionId = addTransformationBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'url') {
						sectionId = addUrlBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'python') {
						sectionId = addPythonBox();
						success = !!sectionId;
						// Set section name if provided
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'html') {
						const htmlOpts: any = {};
						if (input.code) {
							htmlOpts.code = String(input.code);
						}
						sectionId = addHtmlBox(htmlOpts);
						success = !!sectionId;
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					} else if (sectionType === 'sql') {
						const sqlOpts: any = {};
						if (input.query) {
							sqlOpts.query = String(input.query);
						}
						sectionId = addSqlBox(sqlOpts);
						success = !!sectionId;
						if (sectionId && input.name) {
							__kustoSetSectionName(sectionId, input.name);
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error adding section:', err);
				}
				
				if (success && sectionId) { markSectionAgentTouched(sectionId); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { sectionId, success }, error: success ? undefined : 'Failed to add section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				console.error('[Kusto Tools] Error in toolAddSection:', err);
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolRemoveSection':
			// Remove a section by ID
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				
				try {
					if (!sectionId) {
						success = false;
					} else if (sectionId.startsWith('query_') || sectionId.startsWith('copilotQuery_')) {
						removeQueryBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('chart_')) {
						removeChartBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('transformation_')) {
						removeTransformationBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('markdown_')) {
						removeMarkdownBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('python_')) {
						removePythonBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('url_')) {
						removeUrlBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('html_')) {
						removeHtmlBox(sectionId);
						success = true;
					} else if (sectionId.startsWith('sql_')) {
						removeSqlBox(sectionId);
						success = true;
					} else {
						const sectionEl = document.getElementById(sectionId) as any;
						if (sectionEl && typeof sectionEl.remove === 'function') {
							sectionEl.remove();
							success = true;
						}
					}

					if (success) {
						if (queryEditors && queryEditors[sectionId]) {
							delete queryEditors[sectionId];
						}
						if (schemaByBoxId && schemaByBoxId[sectionId]) {
							delete schemaByBoxId[sectionId];
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error removing section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Section not found' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolCollapseSection':
			// Collapse or expand a section
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				const collapsed = !!message.collapsed;
				let success = false;
				
				try {
					const sectionEl = document.getElementById(sectionId) as any;
					if (sectionEl && typeof sectionEl.setExpanded === 'function') {
						sectionEl.setExpanded(!collapsed);
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error collapsing section:', err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to collapse/expand section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolReorderSections':
			// Reorder all sections in the notebook
			try {
				const requestId = String(message.requestId || '');
				const rawSectionIds = Array.isArray(message.sectionIds) ? message.sectionIds.map((id: any) => String(id)) : [];
				// Strip devnotes IDs — they have no DOM presence and cannot be reordered
				const sectionIds = rawSectionIds.filter((id: any) => !id.startsWith('devnotes_'));
				let success = false;
				let error = '';
				
				try {
					const container = document.getElementById('queries-container');
					if (!container) {
						error = 'Container not found';
					} else {
						// Get current section elements (all direct children with an id)
						const currentIds = Array.from(container.children)
							.map((el: any) => el.id)
							.filter((id: any) => id);
						
						// Validate: all current IDs must be in the new order
						const missingIds = currentIds.filter((id: any) => !sectionIds.includes(id));
						const unknownIds = sectionIds.filter((id: any) => !currentIds.includes(id));
						
						if (missingIds.length > 0) {
							error = 'Missing section IDs in reorder list: ' + missingIds.join(', ');
						} else if (unknownIds.length > 0) {
							error = 'Unknown section IDs: ' + unknownIds.join(', ');
						} else if (pState.firstSectionPinned && currentIds.length > 0 && sectionIds[0] !== currentIds[0]) {
							error = 'The first section is pinned and cannot be moved. Its content is stored in the .kql/.csl file.';
						} else {
							// Reorder: move sections to match the new order
							for (const sectionId of sectionIds) {
								const el = document.getElementById(sectionId) as any;
								if (el && el.parentNode === container) {
									container.appendChild(el);
								}
							}
							success = true;
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error reordering sections:', err);
					error = err.message || String(err);
				}
				
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, error: error || undefined }, error: success ? undefined : (error || 'Failed to reorder sections') });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureQuerySection':
			// Configure a query section's connection, database, and optionally update query text
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				let deferResponse = false;
				
				try {
					const editor = queryEditors && queryEditors[sectionId];
					
					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Update query text
					if (input.query !== undefined && editor && typeof editor.setValue === 'function') {
						editor.setValue(String(input.query));
						success = true;
					}
					
					// Update cluster
					if (input.clusterUrl) {
						const conn = (connections || []).find((c: any) => c && String(c.clusterUrl || '').toLowerCase().includes(String(input.clusterUrl).toLowerCase()));
						if (conn) {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.setConnectionId === 'function') {
								kwEl.setConnectionId(conn.id);
								kwEl.dispatchEvent(new CustomEvent('connection-changed', {
									detail: { boxId: sectionId, connectionId: conn.id, clusterUrl: conn.clusterUrl },
									bubbles: true, composed: true,
								}));
								success = true;
							}
						} else {
							// Connection not found - return error with available connections
							const availableConnections = (connections || []).map((c: any) => c && c.clusterUrl ? String(c.clusterUrl) : '').filter(Boolean);
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { 
									success: false, 
									error: `Cluster "${input.clusterUrl}" not found in configured connections.`,
									availableConnections,
									fix: 'Use #listKustoConnections to see available clusters.'
								}
							});
							return;
						}
					}
					
					// Update database (wait a bit for database list to populate after connection change)
					if (input.database) {
						if (input.clusterUrl) {
							await new Promise((r: any) => setTimeout(r, 500));
						}
						const kwEl = __kustoGetQuerySectionElement(sectionId);
						if (kwEl && typeof kwEl.setDatabase === 'function') {
							kwEl.setDatabase(input.database);
							kwEl.dispatchEvent(new CustomEvent('database-changed', {
								detail: { boxId: sectionId, database: input.database },
								bubbles: true, composed: true,
							}));
							success = true;
						}
					}
					
					// Execute if requested — defer the tool response until results arrive (B1 + B2 fix)
					if (input.execute) {
						const sectionEl = document.getElementById(sectionId);
						if (sectionEl) {
							success = true;
							deferResponse = true;

							let responded = false;
							const resultHandler = (resultEvent: any) => {
								try {
									const resultMsg = resultEvent && resultEvent.data;
									if (resultMsg && resultMsg.type === 'queryResult' && resultMsg.boxId === sectionId) {
										if (responded) return;
										responded = true;
										window.removeEventListener('message', resultHandler);

										const result = resultMsg.result || {};
										const rows = result.rows || [];
										const columns = result.columns || [];
										const rowCount = rows.length;

										let resultPreview = '';
										try {
											const previewRows = rows.slice(0, 5);
											resultPreview = JSON.stringify({ columns, rows: previewRows, totalRows: rowCount }, null, 2);
										} catch (e) { console.error('[kusto]', e); }

										postMessageToHost({
											type: 'toolResponse',
											requestId,
											result: { success: true, rowCount, columns, resultPreview }
										});
									} else if (resultMsg && resultMsg.type === 'queryError' && resultMsg.boxId === sectionId) {
										if (responded) return;
										responded = true;
										window.removeEventListener('message', resultHandler);
										postMessageToHost({
											type: 'toolResponse',
											requestId,
											result: { success: false, error: resultMsg.error || 'Query execution failed' }
										});
									} else if (resultMsg && resultMsg.type === 'queryCancelled' && resultMsg.boxId === sectionId) {
										if (responded) return;
										responded = true;
										window.removeEventListener('message', resultHandler);
										postMessageToHost({
											type: 'toolResponse',
											requestId,
											result: { success: false, error: 'Query was cancelled' }
										});
									}
								} catch (e) { console.error('[kusto]', e); }
							};

							window.addEventListener('message', resultHandler);

							// Timeout safety net — send a response if nothing arrives
							setTimeout(() => {
								if (responded) return;
								responded = true;
								window.removeEventListener('message', resultHandler);
								postMessageToHost({
									type: 'toolResponse',
									requestId,
									result: { success: true, resultPreview: '' }
								});
							}, 120000);

							executeQuery(sectionId);
						}
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring query section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId); }
				if (!deferResponse) {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success, resultPreview: '' }, error: success ? undefined : 'Failed to configure query section' });
				}
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolExecuteQuery':
			// Execute a query and return results preview
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				
				// Set up a one-time listener for the result
				const resultHandler = (resultEvent: any) => {
					try {
						const resultMsg = resultEvent && resultEvent.data;
						if (resultMsg && resultMsg.type === 'queryResult' && resultMsg.boxId === sectionId) {
							window.removeEventListener('message', resultHandler);
							
							const result = resultMsg.result || {};
							const rows = result.rows || [];
							const columns = result.columns || [];
							const rowCount = rows.length;
							
							// Create a preview (first 5 rows)
							let preview = '';
							try {
								const previewRows = rows.slice(0, 5);
								preview = JSON.stringify({ columns, rows: previewRows, totalRows: rowCount }, null, 2);
							} catch (e) { console.error('[kusto]', e); }
							
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: true, rowCount, columns, resultPreview: preview }
							});
						} else if (resultMsg && resultMsg.type === 'queryError' && resultMsg.boxId === sectionId) {
							window.removeEventListener('message', resultHandler);
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { success: false, error: resultMsg.error || 'Query execution failed' }
							});
						}
					} catch (e) { console.error('[kusto]', e); }
				};
				
				window.addEventListener('message', resultHandler);
				
				// Set timeout to clean up listener
				setTimeout(() => {
					window.removeEventListener('message', resultHandler);
				}, 120000); // 2 minute timeout
				
				executeQuery(sectionId);
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolUpdateMarkdownSection':
			// Update a markdown section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Accept both 'text' and 'content' - LLMs may use either property name
					const textValue = input.text ?? input.content;
					if (textValue !== undefined) {
						const textToSet = String(textValue);
						pState.pendingMarkdownTextByBoxId = pState.pendingMarkdownTextByBoxId || {};
						pState.pendingMarkdownTextByBoxId[sectionId] = textToSet;
						
						// Try to update existing editor (exposed on window from extraBoxes.js)
						const editorInstance = window.__kustoMarkdownEditors && window.__kustoMarkdownEditors[sectionId];
						if (editorInstance && typeof editorInstance.setValue === 'function') {
							editorInstance.setValue(textToSet);
							success = true;
							
							// Fit to contents after updating - with retries to handle async layout
							const fitToContents = () => {
								try {
									__kustoMaximizeMarkdownBox(sectionId);
								} catch (e) { console.error('[kusto]', e); }
							};
							// Apply immediately and with delays to handle async editor layout
							fitToContents();
							setTimeout(fitToContents, 100);
							setTimeout(fitToContents, 300);
							// If currently in Preview mode, re-render the viewer immediately
							try {
								if (typeof window.__kustoApplyMarkdownEditorMode === 'function') {
									window.__kustoApplyMarkdownEditorMode(sectionId);
								}
							} catch (e) { console.error('[kusto]', e); }
						} else {
							// Editor not initialized yet - text will be applied when editor initializes
							// from __kustoPendingMarkdownTextByBoxId
							success = true;
						}
					}
					
					if (input.mode && typeof window.__kustoSetMarkdownMode === 'function') {
						window.__kustoSetMarkdownMode(sectionId, input.mode);
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error updating markdown section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to update markdown section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureChart':
			// Configure a chart section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				let validationStatus: any = null;
				
				try {
					// Validate that the target section is actually a chart
					const chartEl = document.getElementById(sectionId);
					if (!chartEl || chartEl.tagName !== 'KW-CHART-SECTION') {
						postMessageToHost({
							type: 'toolResponse',
							requestId,
							result: {
								success: false,
								error: `Section '${sectionId}' is not a chart section. Use configureQuerySection for query sections.`,
							}
						});
						break;
					}

					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Apply chart configuration
					if (typeof window.__kustoConfigureChart === 'function') {
						window.__kustoConfigureChart(sectionId, input);
						success = true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingChartConfig = window.__kustoPendingChartConfig || {};
						window.__kustoPendingChartConfig[sectionId] = input;
						success = true;
					}
					
					// Get validation status to help agent verify configuration
					validationStatus = __kustoGetChartValidationStatus(sectionId);
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring chart:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId); }
				// Include validation status in response so agent can verify configuration worked
				const result = { success, ...( validationStatus ? { validation: validationStatus } : {}) };
				postMessageToHost({ type: 'toolResponse', requestId, result, error: success ? undefined : 'Failed to configure chart' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureTransformation':
			// Configure a transformation section
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				
				try {
					// Update section name if provided
					if (input.name !== undefined) {
						__kustoSetSectionName(sectionId, input.name);
						success = true;
					}
					
					// Apply transformation configuration
					if (typeof window.__kustoConfigureTransformation === 'function') {
						window.__kustoConfigureTransformation(sectionId, input);
						success = true;
					} else {
						// Fallback: store in pending state
						window.__kustoPendingTransformationConfig = window.__kustoPendingTransformationConfig || {};
						window.__kustoPendingTransformationConfig[sectionId] = input;
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring transformation:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { success }, error: success ? undefined : 'Failed to configure transformation' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolConfigureHtmlSection':
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				let success = false;
				
				try {
					const el = document.getElementById(sectionId) as any;
					if (el && typeof el.setCode === 'function') {
						if (typeof message.name === 'string') {
							__kustoSetSectionName(sectionId, message.name);
						}
						if (typeof message.code === 'string') {
							el.setCode(message.code);
						}
						if (typeof message.mode === 'string') {
							el.setMode(message.mode);
						}
						success = true;
					}
				} catch (err: any) {
					console.error('[Kusto Tools] Error configuring HTML section:', err);
				}
				
				if (success) { markSectionAgentTouched(sectionId); }
				postMessageToHost({ type: 'toolResponse', requestId, result: { success, sectionId }, error: success ? undefined : 'Failed to configure HTML section' });
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;

		// ── SQL tool messages ───────────────────────────────────────────

		case 'toolListSqlConnections':
			try {
				const requestId = String(message.requestId || '');
				const conns = (Array.isArray(sqlConnections) ? sqlConnections : []).map((c: any) => ({
					id: c.id, name: c.name, serverUrl: c.serverUrl, dialect: c.dialect,
				}));
				postMessageToHost({ type: 'toolResponse', requestId, result: { connections: conns } });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { connections: [] }, error: err.message || String(err) });
			}
			break;

		case 'toolConfigureSqlSection':
			try {
				const requestId = String(message.requestId || '');
				const input = message.input || {};
				const sectionId = String(input.sectionId || '');
				let success = false;
				const sqlEl = __kustoGetSqlSectionElement(sectionId);

				if (input.name !== undefined && sqlEl && typeof sqlEl.setName === 'function') {
					sqlEl.setName(String(input.name));
					success = true;
				}
				if (input.query !== undefined && sqlEl && typeof sqlEl.setQuery === 'function') {
					sqlEl.setQuery(String(input.query));
					success = true;
				}
				if (input.serverUrl && sqlEl) {
					const conn = (Array.isArray(sqlConnections) ? sqlConnections : []).find(
						(c: any) => c && String(c.serverUrl || '').toLowerCase().includes(String(input.serverUrl).toLowerCase())
					);
					if (conn && typeof sqlEl.setSqlConnectionId === 'function') {
						sqlEl.setSqlConnectionId(conn.id);
						sqlEl.dispatchEvent(new CustomEvent('sql-connection-changed', {
							detail: { boxId: sectionId, connectionId: conn.id, serverUrl: conn.serverUrl },
							bubbles: true, composed: true,
						}));
						success = true;
					}
				}
				if (input.database && sqlEl && typeof sqlEl.setDatabase === 'function') {
					if (input.serverUrl) await new Promise((r: any) => setTimeout(r, 500));
					sqlEl.setDatabase(String(input.database));
					sqlEl.dispatchEvent(new CustomEvent('sql-database-changed', {
						detail: { boxId: sectionId, database: input.database },
						bubbles: true, composed: true,
					}));
					success = true;
				}
				if (input.execute && sqlEl) {
					// Trigger execution via event
					sqlEl.dispatchEvent(new CustomEvent('sql-run', { bubbles: true, composed: true }));
					success = true;
				}
				postMessageToHost({ type: 'toolResponse', requestId, result: { success } });
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;

		case 'toolGetSqlSchema':
			try {
				const requestId = String(message.requestId || '');
				const sectionId = String(message.sectionId || '');
				const schema = schemaByBoxId[sectionId];
				if (schema) {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: true, schema } });
				} else {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No schema loaded for this section. Connect to a server and select a database first.' } });
				}
			} catch (err: any) {
				postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false }, error: err.message || String(err) });
			}
			break;
		
		case 'toolDelegateToKustoWorkbenchCopilot':
			// Delegate a question to the internal Copilot Chat by simulating user interaction:
			// 1. Toggle copilot button to show chat
			// 2. Paste question into chat input
			// 3. Click send button
			// 4. Wait for results to be displayed before returning
			(async () => {
				try {
					const requestId = String(message.requestId || '');
					const input = message.input || {};
					const question = String(input.question || '');
					let sectionId = String(input.sectionId || '');
					
					// If no section specified, use the first query section or create one
					if (!sectionId) {
						const sections = document.querySelectorAll('[data-section-type="query"]');
						if (sections.length > 0) {
							sectionId = sections[0].id;
						} else {
							sectionId = addQueryBox();
						}
					}
					
					if (!sectionId) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No query section available' } });
						return;
					}
					
					// VALIDATE: Check that connection and database are configured on this section
					const currentConnectionId = __kustoGetConnectionId(sectionId) || '';
					const currentDatabase = __kustoGetDatabase(sectionId) || '';
					
					// Get cluster URL for context
					let currentClusterUrl = '';
					try {
						if (currentConnectionId && Array.isArray(connections)) {
							const conn = connections.find((c: any) => c && String(c.id || '') === currentConnectionId);
							currentClusterUrl = conn ? String(conn.clusterUrl || '') : '';
						}
					} catch (e) { console.error('[kusto]', e); }
					
					if (!currentConnectionId) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: 'Query section has no cluster connection configured.',
								sectionId,
								fix: 'Use #configureKustoQuerySection to set up the connection first. Call #listKustoFavorites to find available cluster/database pairs.'
							}
						});
						return;
					}
					
					if (!currentDatabase) {
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false, 
								error: `Query section is connected to cluster${currentClusterUrl ? ` (${currentClusterUrl})` : ''} but no database is selected.`,
								sectionId,
								clusterUrl: currentClusterUrl || undefined,
								fix: 'Use #configureKustoQuerySection to set the database. You can use #getKustoSchema with the clusterUrl to see available databases.'
							}
						});
						return;
					}
				
				// Ensure the section is in 'Run Query' mode (plain) — not 'take 100' or 'sample 100'.
				// This prevents the Copilot-generated queries from having unwanted limits appended.
				try {
					setRunMode(sectionId, 'plain');
				} catch (e) { console.error('[kusto]', e); }

				// Step 1: Show the Copilot Chat panel (toggle the button)
				{
					const kwEl = __kustoGetQuerySectionElement(sectionId);
					if (kwEl && typeof kwEl.setCopilotChatVisible === 'function') {
						kwEl.setCopilotChatVisible(true);
					}
				}
				
				// Give the UI a moment to render
				await new Promise((r: any) => setTimeout(r, 100));
				
				// Step 2: Paste the question into the chat input via kw-copilot-chat public API
				const chatPane = document.getElementById(sectionId + '_copilot_chat_pane');
				const chatEl = chatPane?.querySelector('kw-copilot-chat') as any;
				if (!chatEl || typeof chatEl.setInputText !== 'function') {
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Copilot chat input not found. Is Copilot available?' } });
					return;
				}
				chatEl.setInputText(question);
				
				// Set up listener for results BEFORE clicking send
				let responded = false;
				let generatedQuery = '';
				let queryGenerated = false;
				let pendingQueryResult: any = null; // Store queryResult if it arrives before copilotWriteQueryDone
				
				// Helper to send successful response
				const sendSuccessResponse = (msg: any) => {
					if (responded) return;
					responded = true;
					window.removeEventListener('message', resultHandler);
					
					// Get current query from editor
					try {
						const editor = queryEditors && queryEditors[sectionId];
						if (editor && typeof editor.getValue === 'function') {
							generatedQuery = editor.getValue() || generatedQuery;
						}
					} catch (e) { console.error('[kusto]', e); }
					
					// Don't call __kustoCopilotWriteQueryDone here — the regular
					// 'copilotWriteQueryDone' handler already does it.
					
					// Get the results
					let rows: any[] = [];
					let columns: any[] = [];
					let rowCount = 0;
					
					// Try to get from the result state (most reliable after display)
					try {
						const resultState = getResultsState(sectionId);
						if (resultState) {
							columns = Array.isArray(resultState.columns) ? resultState.columns : [];
							rows = Array.isArray(resultState.rows) ? resultState.rows : [];
							rowCount = rows.length;
						}
					} catch (e) { console.error('[kusto]', e); }
					
					// Fallback to message data
					if (columns.length === 0 && msg && msg.result && msg.result.primaryResults && msg.result.primaryResults.length > 0) {
						const primary = msg.result.primaryResults[0];
						columns = primary.columns ? primary.columns.map((c: any) => c.name || c) : [];
						rows = primary.rows || [];
						rowCount = rows.length;
					}
					
					// Limit rows for response size
					const truncated = rows.length > 100;
					if (truncated) {
						rows = rows.slice(0, 100);
					}
					
					postMessageToHost({ 
						type: 'toolResponse', 
						requestId, 
						result: { 
							success: true,
							query: generatedQuery,
							rowCount,
							columns,
							results: rows,
							truncated: truncated ? 'Results truncated to 100 rows' : undefined
						}
					});
				};
				
				const resultHandler = (event: any) => {
					try {
						const msg = event && event.data;
						if (!msg || responded) return;
						
						// Copilot finished generating/writing query
						if (msg.type === 'copilotWriteQueryDone' && msg.boxId === sectionId) {
							queryGenerated = true;
							try {
								const editor = queryEditors && queryEditors[sectionId];
								generatedQuery = editor && typeof editor.getValue === 'function' ? editor.getValue() : '';
							} catch (e) { console.error('[kusto]', e); }
							
							if (!msg.ok) {
								responded = true;
								window.removeEventListener('message', resultHandler);
								
								// Don't call __kustoCopilotWriteQueryDone here — the regular
								// 'copilotWriteQueryDone' handler already does it, and calling
								// it again produces a duplicate "Canceled." notification.
								
								postMessageToHost({ 
									type: 'toolResponse', 
									requestId, 
									result: { 
										success: false,
										error: msg.message || 'Copilot failed to generate query',
										query: generatedQuery || undefined
									}
								});
								return;
							}
							
							// If we already received queryResult, process it now
							if (pendingQueryResult) {
								sendSuccessResponse(pendingQueryResult);
								return;
							}
							// Otherwise wait for queryResult
						}
						
						// Query results arrived
						if (msg.type === 'queryResult' && msg.boxId === sectionId) {
							if (queryGenerated) {
								// copilotWriteQueryDone already arrived with ok=true, send response now
								sendSuccessResponse(msg);
							} else {
								// copilotWriteQueryDone hasn't arrived yet, store for later
								pendingQueryResult = msg;
							}
						}
						
						// Query execution error
						if (msg.type === 'queryError' && msg.boxId === sectionId && queryGenerated) {
							responded = true;
							window.removeEventListener('message', resultHandler);
							
							postMessageToHost({ 
								type: 'toolResponse', 
								requestId, 
								result: { 
									success: false,
									query: generatedQuery || undefined,
									error: msg.error || 'Query execution failed'
								}
							});
						}
					} catch (err: any) {
						console.error('[Kusto Tools] Error in result handler:', err);
					}
				};
				
				window.addEventListener('message', resultHandler);
				
				// Timeout after 3 minutes
				const timeoutId = setTimeout(() => {
					if (!responded) {
						responded = true;
						window.removeEventListener('message', resultHandler);
						
						// Clear the Copilot chat "thinking..." state on timeout
						// (unlike cancel/error, no regular handler will clear this)
						try {
							const kwEl = __kustoGetQuerySectionElement(sectionId);
							if (kwEl && typeof kwEl.copilotWriteQueryDone === 'function') {
								kwEl.copilotWriteQueryDone(false, 'Request timed out');
							}
						} catch (e) { console.error('[kusto]', e); }
						
						postMessageToHost({ 
							type: 'toolResponse', 
							requestId, 
							result: { 
								success: false,
								timedOut: true,
								query: generatedQuery || undefined,
								error: 'Request timed out after 3 minutes'
							}
						});
					}
				}, 180000);
				
				// Step 3: Mark this send as agent-driven (require tool use) and send
				try {
					if (chatEl && typeof chatEl.setRequireToolUseOnNextSend === 'function') {
						chatEl.setRequireToolUseOnNextSend(true);
					}
				} catch (e) { console.error('[kusto]', e); }

				const kwEl2 = __kustoGetQuerySectionElement(sectionId);
				if (kwEl2 && typeof kwEl2.copilotWriteQuerySend === 'function') {
					kwEl2.copilotWriteQuerySend();
				} else {
					// Clean up and report error
					clearTimeout(timeoutId);
					window.removeEventListener('message', resultHandler);
					postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Could not find send button or send function' } });
				}
				
				} catch (err: any) {
					console.error('[Kusto Tools] Error delegating to Copilot:', err);
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
		
		case 'toolDelegateToSqlCopilot':
			// Delegate a question to the SQL Copilot Chat — simplified version of the Kusto handler.
			(async () => {
				try {
					const requestId = String(message.requestId || '');
					const input = message.input || {};
					const question = String(input.question || '');
					let sectionId = String(input.sectionId || '');
					
					// If no section specified, use the first SQL section
					if (!sectionId) {
						const sections = document.querySelectorAll('[data-section-type="sql"]');
						if (sections.length > 0) {
							sectionId = sections[0].id;
						} else {
							// Try to find any SQL section via the sqlBoxes array
							if (typeof sqlBoxes !== 'undefined' && sqlBoxes.length > 0) {
								sectionId = sqlBoxes[0];
							}
						}
					}
					
					if (!sectionId) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'No SQL section available. Add a SQL section first.' } });
						return;
					}
					
					const sqlEl = __kustoGetSqlSectionElement(sectionId);
					if (!sqlEl) {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: `SQL section "${sectionId}" not found.` } });
						return;
					}
					
					// Ensure copilot chat is visible
					if (typeof sqlEl.setCopilotChatVisible === 'function') {
						sqlEl.setCopilotChatVisible(true);
					}
					await new Promise((r: any) => setTimeout(r, 150));
					
					// Find the chat element
					const chatEl = typeof sqlEl.getCopilotChatEl === 'function' ? sqlEl.getCopilotChatEl() : null;
					if (!chatEl || typeof chatEl.setInputText !== 'function') {
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'SQL Copilot chat not available. Is Copilot enabled?' } });
						return;
					}
					
					chatEl.setInputText(question);
					
					// Listen for results
					let responded = false;
					let generatedQuery = '';
					
					const resultHandler = (event: any) => {
						try {
							const msg = event && event.data;
							if (!msg || responded) return;
							if (msg.type === 'copilotWriteQueryDone' && msg.boxId === sectionId) {
								responded = true;
								window.removeEventListener('message', resultHandler);
								try {
									if (typeof sqlEl.getCopilotEditorValue === 'function') {
										generatedQuery = sqlEl.getCopilotEditorValue() || '';
									}
								} catch (e) { console.error('[kusto]', e); }
								postMessageToHost({
									type: 'toolResponse', requestId,
									result: { success: !!msg.ok, answer: msg.ok ? 'Query generated successfully.' : (msg.message || 'Failed'), query: generatedQuery || undefined, error: msg.ok ? undefined : (msg.message || 'Failed') }
								});
							}
						} catch (err: any) { console.error('[kusto]', err); }
					};
					
					window.addEventListener('message', resultHandler);
					setTimeout(() => {
						if (!responded) {
							responded = true;
							window.removeEventListener('message', resultHandler);
							postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, timedOut: true, error: 'Request timed out after 3 minutes' } });
						}
					}, 180000);
					
					// Send the message
					const sendBtn = chatEl.shadowRoot?.querySelector('.send-btn') as HTMLElement | null;
					if (sendBtn) sendBtn.click();
					else {
						window.removeEventListener('message', resultHandler);
						postMessageToHost({ type: 'toolResponse', requestId, result: { success: false, error: 'Could not find send button' } });
					}
				} catch (err: any) {
					console.error('[kusto]', err);
					postMessageToHost({ type: 'toolResponse', requestId: message.requestId, result: { success: false, error: err.message || String(err) } });
				}
			})();
			break;
		
		case 'changedSections':
			// Update per-section unsaved-change indicators.
			// Message shape: ChangedSectionsMessage { type, changes: SectionChangeInfo[] }
			try {
				const changes: Array<{ id: string; status: 'modified' | 'new'; contentChanged: boolean; settingsChanged: boolean }> = Array.isArray(message.changes) ? message.changes : [];
				const changedById = new Map<string, 'modified' | 'new'>();
				for (const c of changes) {
					if (c && typeof c.id === 'string' && c.id) {
						changedById.set(c.id, c.status === 'new' ? 'new' : 'modified');
					}
				}
				// Update all section elements in the DOM.
				const container = document.getElementById('queries-container');
				if (container) {
					const sectionPrefixes = ['query_', 'chart_', 'transformation_', 'markdown_', 'python_', 'url_', 'html_', 'sql_'];
					for (const child of Array.from(container.children)) {
						const id = child.id || '';
						if (!id || !sectionPrefixes.some(p => id.startsWith(p))) continue;
						const el = child as any;
						const shell = el.shadowRoot?.querySelector('kw-section-shell');
						const status = changedById.get(id) || '';
						if (shell) {
							shell.hasChanges = status;
							shell.showDiffBtn = status === 'modified';
						}
						// Mirror attribute on the section host for :host() glow styles.
						if (status) {
							el.setAttribute('has-changes', status);
							el.title = status === 'new'
								? 'Section was added after the last save'
								: 'Section has unsaved changes';
						} else {
							el.removeAttribute('has-changes');
							el.removeAttribute('title');
						}
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'shareContentReady':
			// Write rich HTML + plain text to the clipboard for Teams / rich-text paste.
			try {
				const html = String(message.html || '');
				const text = String(message.text || '');
				if (navigator.clipboard && typeof navigator.clipboard.write === 'function') {
					const htmlBlob = new Blob([html], { type: 'text/html' });
					const textBlob = new Blob([text], { type: 'text/plain' });
					navigator.clipboard.write([
						new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
					]).catch(() => {
						// Fallback to plain text if HTML clipboard write fails.
						try { navigator.clipboard.writeText(text); } catch (e) { console.error('[kusto]', e); }
					});
				} else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(text);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'resetCopilotModelSelection':
			// Clear the cached model selection from webview state and localStorage
			try {
				// Clear from vscode state
				const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
				delete state.lastOptimizeModelId;
				if (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.setState) {
					_win.vscode.setState(state);
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				// Clear from localStorage
				localStorage.removeItem('kusto.optimize.lastModelId');
			} catch (e) { console.error('[kusto]', e); }
			break;
	}
});
