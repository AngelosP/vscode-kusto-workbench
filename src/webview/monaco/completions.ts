// Monaco completions module - extracted from monaco.ts (Phase 6 decomposition).
// Custom KQL completion provider (DISABLED - monaco-kusto handles completions).
// Pipe operator suggestions, dot-command completions, column inference.
// Window bridge exports at bottom for remaining callers.
import { __kustoGeneratedFunctionsMerged, setGeneratedFunctionsMerged } from './monaco';
import { queryEditorBoxByModelUri, activeQueryEditorBoxId, schemaByBoxId, connections, schemaByConnDb } from '../modules/state';
export {};

const _win = window;

// AMD globals loaded by require() - available globally after Monaco loads.
declare const monaco: any;

// -- Dependencies from other modules --
// Populated by monaco.ts via _win.__kustoInitCompletionDeps() inside the AMD callback,
// before any completion function is ever called.
let KUSTO_FUNCTION_DOCS: any;
let KUSTO_KEYWORD_DOCS: any;
let KUSTO_CONTROL_COMMAND_DOCS_BASE_URL: string;
let KUSTO_CONTROL_COMMAND_DOCS_VIEW: string;
let __kustoControlCommands: any;
let findEnclosingFunctionCall: any;
let getTokenAtPosition: any;
// From monaco-diagnostics.ts (set on window at import time):
let __kustoGetStatementStartAtOffset: any;
let __kustoScanIdentifiers: any;
let __kustoSplitTopLevelStatements: any;
let __kustoSplitPipelineStagesDeep: any;
// From monaco.ts module scope:
let __kustoGetColumnsByTable: any;
// From queryBoxes.ts (schema logic):
let ensureSchemaForBox: any;

export function __kustoInitCompletionDeps(deps: any) {
	KUSTO_FUNCTION_DOCS = deps.KUSTO_FUNCTION_DOCS;
	KUSTO_KEYWORD_DOCS = deps.KUSTO_KEYWORD_DOCS;
	KUSTO_CONTROL_COMMAND_DOCS_BASE_URL = deps.KUSTO_CONTROL_COMMAND_DOCS_BASE_URL;
	KUSTO_CONTROL_COMMAND_DOCS_VIEW = deps.KUSTO_CONTROL_COMMAND_DOCS_VIEW;
	__kustoControlCommands = deps.__kustoControlCommands;
	findEnclosingFunctionCall = deps.findEnclosingFunctionCall;
	getTokenAtPosition = deps.getTokenAtPosition;
	__kustoGetStatementStartAtOffset = deps.__kustoGetStatementStartAtOffset;
	__kustoScanIdentifiers = deps.__kustoScanIdentifiers;
	__kustoSplitTopLevelStatements = deps.__kustoSplitTopLevelStatements;
	__kustoSplitPipelineStagesDeep = deps.__kustoSplitPipelineStagesDeep;
	__kustoGetColumnsByTable = deps.__kustoGetColumnsByTable;
	ensureSchemaForBox = deps.ensureSchemaForBox;
}

// -- Pipe operator suggestions --
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


// -- Dot-command completion context --
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


// -- Completion provider (DISABLED - registration commented out) --
let __kustoProvideCompletionItemsForDiagnostics = null;
const __kustoCompletionProvider = {
	triggerCharacters: [' ', '|', '.'],
	provideCompletionItems: async function (model: any, position: any) {
		// Generated Kusto function names (from Microsoft Learn TOC) are loaded by `src/webview/generated/functions.generated.js`.
		// Merge those into our hand-authored docs so completions are comprehensive even when we don't
		// have detailed arg/return docs for every function.
		try {
			if (typeof window !== 'undefined' && window) {
				if (!__kustoGeneratedFunctionsMerged) {
					setGeneratedFunctionsMerged(true);
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
						} catch (e) { console.error('[kusto]', e); }

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
		} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }

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
				} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }
		if (!boxId) {
			boxId = activeQueryEditorBoxId;
		}
		const schema = boxId ? schemaByBoxId[boxId] : null;
		if (!schema || !schema.tables) {
			// Kick off a background fetch if schema isn't ready yet (but still return operator suggestions).
			if (typeof ensureSchemaForBox === 'function') {
				ensureSchemaForBox(boxId);
			}

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
			} catch (e) { console.error('[kusto]', e); }

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
				for (const c of (connections || [])) {
					if (!c || !c.id) continue;
					const url = String(c.clusterUrl || '').trim();
					if (!url) continue;
					const norm = __kustoNormalizeClusterForKusto(url).toLowerCase();
					if (norm === target) {
						return String(c.id);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			return null;
		};

		const __kustoEnsureSchemaForClusterDb = async (clusterName: any, databaseName: any) => {
			try {
				const cid = __kustoFindConnectionIdByClusterName(clusterName);
				const db = String(databaseName || '').trim();
				if (!cid || !db) return null;
				const key = cid + '|' + db;
				try {
					if (schemaByConnDb && schemaByConnDb[key]) {
						return schemaByConnDb[key];
					}
				} catch (e) { console.error('[kusto]', e); }
				if (typeof _win.__kustoRequestSchema === 'function') {
					const sch = await _win.__kustoRequestSchema(cid, db, false);
					try {
						if (sch && schemaByConnDb) {
							schemaByConnDb[key] = sch;
						}
					} catch (e) { console.error('[kusto]', e); }
					return sch;
				}
			} catch (e) { console.error('[kusto]', e); }
			return null;
		};

		// Special context: inside `| join ... on ...` or `| lookup ... on ...` we want columns (not tables).
		const __kustoBuildLetTabularResolverForCompletion = (text: any) => {
			const tablesByLower: any = {};
			try {
				for (const t of (schema && Array.isArray(schema.tables) ? schema.tables : [])) {
					tablesByLower[String(t).toLowerCase()] = String(t);
				}
			} catch (e) { console.error('[kusto]', e); }
			const letSources: any = {};
			const extractSourceLower = (rhsText: any) => {
				const rhs = String(rhsText || '').trim();
				if (!rhs) return null;
				try {
					const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
					if (m && m[1]) return String(m[1]).toLowerCase();
				} catch (e) { console.error('[kusto]', e); }
				try {
					const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
					if (m && m[1]) return String(m[1]).toLowerCase();
				} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }

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
			} catch (e) { console.error('[kusto]', e); }

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
		} catch (e) { console.error('[kusto]', e); }

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
			} catch (e) { console.error('[kusto]', e); }

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
							} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
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
							} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }

				const letSources: any = {};
				const extractSourceLower = (rhsText: any) => {
					const rhs = String(rhsText || '').trim();
					if (!rhs) return null;
					try {
						const fq = __kustoParseFullyQualifiedTableExpr(rhs);
						if (fq) {
							return { tableLower: String(fq.table).toLowerCase(), cluster: fq.cluster, database: fq.database, table: fq.table };
						}
					} catch (e) { console.error('[kusto]', e); }
					try {
						const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
						if (m && m[1]) return { tableLower: String(m[1]).toLowerCase(), cluster: null, database: null, table: String(m[1]) };
					} catch (e) { console.error('[kusto]', e); }
					try {
						const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
						if (m && m[1]) return { tableLower: String(m[1]).toLowerCase(), cluster: null, database: null, table: String(m[1]) };
					} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }

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
				} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
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
					} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }
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
			} catch (e) { console.error('[kusto]', e); }
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

// Window bridge removed (D8) — __kustoProvideCompletionItemsForDiagnostics is dead
// (diagnostics module has uninitialized local let that shadows it).
