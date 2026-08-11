import { DatabaseSchemaIndex } from '../kustoClient';
import { KqlDiagnostic, KqlDiagnosticSeverity, type KqlPosition, type KqlRange, type KqlTableReference } from './protocol';
import { getColumnsByTable } from '../schemaIndexUtils';
import { analyzeKqlSource, isKqlNameInScope, resolveKqlLetSourceName, type KqlSourceStatement } from './sourceAnalysis';

type Token =
	| { type: 'ident'; value: string; offset: number; endOffset: number; depth: number }
	| { type: 'pipe'; value: '|'; offset: number; endOffset: number; depth: number };

// Keep this list small-ish and high-value; it primarily prevents false "unknown column" errors
// when a function name appears in expressions.
const KNOWN_FUNCTION_NAMES = new Set(
	[
		// aggregates
		'count', 'countif', 'dcount', 'dcountif', 'sum', 'sumif', 'avg', 'avgif', 'min', 'max', 'percentile',
		// time
		'ago', 'now', 'datetime_add', 'datetime_diff', 'format_datetime',
		// binning
		'bin', 'bin_at',
		// conversion
		'tostring', 'toint', 'tolong', 'toreal', 'todatetime', 'tobool',
		// string
		'strlen', 'substring', 'strcat', 'replace_string', 'trim', 'split',
		// dynamic/json
		'parse_json', 'extractjson',
		// null/emptiness
		'isnull', 'isnotnull', 'isempty', 'isnotempty', 'coalesce',
		// conditional
		'iif', 'iff', 'case'
	].map((s) => s.toLowerCase())
);

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const buildLineStarts = (text: string): number[] => {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
};

const offsetToPosition = (lineStarts: number[], offset: number): KqlPosition => {
	const off = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = lineStarts[mid];
		const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
		if (off < start) {
			hi = mid - 1;
		} else if (off >= nextStart) {
			lo = mid + 1;
		} else {
			return { line: mid, character: off - start };
		}
	}
	const lastLine = Math.max(1, lineStarts.length) - 1;
	const start = lineStarts[lastLine] ?? 0;
	return { line: lastLine, character: off - start };
};

const isIdentStart = (ch: number) => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95;
const isIdentPart = (ch: number) => isIdentStart(ch) || (ch >= 48 && ch <= 57) || ch === 45;

const isDotCommandStatement = (stmtText: string): boolean => String(stmtText ?? '').trimStart().startsWith('.');

const scanTokens = (text: string): Token[] => {
	const tokens: Token[] = [];
	let i = 0;
	let depth = 0;
	while (i < text.length) {
		const ch = text.charCodeAt(i);

		// whitespace
		if (ch === 10 || ch === 13 || ch === 9 || ch === 32) {
			i++;
			continue;
		}
		// depth tracking
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
		// identifiers
		if (isIdentStart(ch)) {
			const start = i;
			i++;
			while (i < text.length && isIdentPart(text.charCodeAt(i))) i++;
			const value = text.slice(start, i);
			tokens.push({ type: 'ident', value, offset: start, endOffset: i, depth });
			continue;
		}
		// pipe
		if (ch === 124 /* | */) {
			tokens.push({ type: 'pipe', value: '|', offset: i, endOffset: i + 1, depth });
			i++;
			continue;
		}

		i++;
	}
	return tokens;
};

const splitTopLevelStatements = (text: string): Array<{ startOffset: number; text: string }> =>
	analyzeKqlSource(text).statements.map((statement) => ({
		startOffset: statement.startOffset,
		text: statement.text
	}));

const levenshtein = (a: string, b: string): number => {
	if (a === b) return 0;
	if (!a) return b.length;
	if (!b) return a.length;
	const n = a.length;
	const m = b.length;
	const prev = new Array<number>(m + 1);
	const cur = new Array<number>(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		const sc = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const cost = sc === b.charCodeAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= m; j++) prev[j] = cur[j];
	}
	return prev[m];
};

const bestMatches = (needle: string, candidates: string[], maxCount: number): string[] => {
	const n = String(needle ?? '');
	const nl = n.toLowerCase();
	const scored: Array<{ cand: string; score: number }> = [];
	for (const c of Array.isArray(candidates) ? candidates : []) {
		const cand = String(c ?? '');
		if (!cand) continue;
		const cl = cand.toLowerCase();
		const dist = levenshtein(nl, cl);
		const prefixBoost = cl.startsWith(nl) ? -2 : 0;
		scored.push({ cand, score: dist + prefixBoost });
	}
	scored.sort((a, b) => a.score - b.score || a.cand.localeCompare(b.cand));
	const out: string[] = [];
	const seen = new Set<string>();
	for (const it of scored) {
		if (out.length >= Math.max(1, maxCount || 5)) break;
		const k = it.cand.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(it.cand);
	}
	return out;
};

const toRange = (lineStarts: number[], startOffset: number, endOffset: number): KqlRange => {
	const start = offsetToPosition(lineStarts, startOffset);
	const end = offsetToPosition(lineStarts, Math.max(startOffset + 1, endOffset));
	return { start, end };
};

const sameLower = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** @internal – exported for unit tests only */
export { splitTopLevelStatements as _splitTopLevelStatements };

export class KqlLanguageService {
	findTableReferences(text: string): KqlTableReference[] {
		return analyzeKqlSource(text).physicalTableReferences.map((reference) => ({
			name: reference.name,
			startOffset: reference.startOffset,
			endOffset: reference.endOffset
		}));
	}

	getDiagnostics(text: string, schema: DatabaseSchemaIndex | undefined | null): KqlDiagnostic[] {
		const diagnostics: KqlDiagnostic[] = [];
		const analysis = analyzeKqlSource(text);
		const raw = analysis.text;
		const rawForParse = analysis.maskedText;
		if (!raw.trim()) {
			return diagnostics;
		}
		const sourceStatements: readonly KqlSourceStatement[] = analysis.statements.length
			? analysis.statements
			: [Object.freeze({ startOffset: 0, endOffset: raw.length, text: raw, maskedText: rawForParse })];

		const lineStarts = buildLineStarts(raw);
		const tables = schema?.tables && Array.isArray(schema.tables) ? schema.tables : [];
		const columnsByTable = getColumnsByTable(schema);
		const columnTypesByTable = schema?.columnTypesByTable && typeof schema.columnTypesByTable === 'object' ? schema.columnTypesByTable : undefined;
		const tablesByLower = new Map<string, string>();
		for (const t of tables) {
			try {
				tablesByLower.set(String(t).toLowerCase(), String(t));
			} catch {
				// ignore
			}
		}

		const letDeclaredNamesByLower = new Map(analysis.letBindings.map((binding) => [binding.nameLower, binding.name]));
		const resolveTabularLetToTable = (nameLower: string, atOffset: number = analysis.text.length): string | null => {
			const sourceName = resolveKqlLetSourceName(analysis, nameLower, atOffset);
			return sourceName ? tablesByLower.get(sourceName.toLowerCase()) ?? null : null;
		};

		const tabularNameCandidates = (() => {
			try {
				const byLower = new Map<string, string>();
				for (const t of tables) {
					const s = String(t);
					byLower.set(s.toLowerCase(), s);
				}
				for (const v of letDeclaredNamesByLower.values()) {
					const s = String(v);
					byLower.set(s.toLowerCase(), s);
				}
				return Array.from(byLower.values());
			} catch {
				return tables.slice();
			}
		})();

		const reportUnknown = (code: string, what: 'table' | 'column', name: string, startOffset: number, endOffset: number, candidates: string[]) => {
			const prefixLower = String(name || '').toLowerCase();
			const filtered = prefixLower
				? (candidates || []).filter((c) => String(c || '').toLowerCase().startsWith(prefixLower))
				: (candidates || []);
			const best = bestMatches(name, filtered, 5);
			const didYouMean = best.length ? ` Did you mean: ${best.map((s) => `\`${s}\``).join(', ')}?` : '';
			diagnostics.push({
				range: toRange(lineStarts, startOffset, endOffset),
				severity: KqlDiagnosticSeverity.Error,
				message: `Unknown ${what} \`${name}\`.${didYouMean}`,
				code,
				source: 'Kusto Workbench'
			});
		};

		for (const reference of analysis.physicalTableReferences) {
			if (tables.length && !tablesByLower.has(reference.nameLower)) {
				reportUnknown(
					'KW_UNKNOWN_TABLE',
					'table',
					reference.name,
					reference.startOffset,
					reference.endOffset,
					tabularNameCandidates
				);
			}
		}

		// Basic syntax-ish check: once a statement has started piping, any subsequent non-empty line
		// should either start with '|' or be an indented continuation of a multiline operator (e.g. summarize, where).
		try {
			for (const st of sourceStatements) {
				const stmtText = st.maskedText;
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				const lines = stmtText.split('\n');
				let runningOffset = baseOffset;
				let sawPipe = false;
				let allowIndentedContinuation = false;
				let expectPipeAfterBareId = false;
				for (const line of lines) {
					const trimmed = line.trim();
					const lineEndOffset = runningOffset + line.length;
					const isCommentOnlyLine = !trimmed && analysis.commentRanges.some((range) =>
						range.startOffset < lineEndOffset && runningOffset < range.endOffset
					);
					if (isCommentOnlyLine) {
						runningOffset += line.length + 1;
						continue;
					}
					if (!trimmed || trimmed === ';') {
						sawPipe = false;
						allowIndentedContinuation = false;
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
						expectPipeAfterBareId = false;
						runningOffset += line.length + 1;
						continue;
					}
					if (trimmed.startsWith('|')) {
						sawPipe = true;
						allowIndentedContinuation = /^\|\s*(where|filter|summarize|extend|project\b|project-rename\b|project-away\b|project-keep\b|project-reorder\b|project-smart\b|distinct\b)\b/i.test(trimmed);
						expectPipeAfterBareId = false;
						runningOffset += line.length + 1;
						continue;
					}
					if (!sawPipe) {
						// If a statement starts with a bare identifier on its own line (e.g. a tabular name like `Base`),
						// the next non-empty line should start with '|'. This catches common missing-pipe errors.
						const isBareIdentLine = /^([A-Za-z_][\w-]*)\s*(?:\/\/.*)?$/.test(trimmed);
						if (expectPipeAfterBareId) {
							const localStart = line.search(/\S/);
							const startOffset = runningOffset + Math.max(0, localStart);
							const firstToken = localStart >= 0 ? line.slice(localStart).match(/^([A-Za-z_][\w-]*)/) : null;
							const tokLen = firstToken?.[1] ? firstToken[1].length : 1;
							diagnostics.push({
								range: toRange(lineStarts, startOffset, startOffset + tokLen),
								severity: KqlDiagnosticSeverity.Error,
								message: 'Unexpected text after a query source. Did you forget to prefix this line with `|`?',
								code: 'KW_EXPECTED_PIPE',
								source: 'Kusto Workbench'
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
						const isIndented = /^\s+/.test(line);
						const isCommaLedContinuation = trimmed.startsWith(',');
						// In KQL, newlines are whitespace. For operators that support multiline clauses
						// (summarize/project/extend/where/etc.), don't require indentation on continuation lines.
						if (allowIndentedContinuation || isIndented || isCommaLedContinuation || trimmed.startsWith('(') || trimmed.startsWith(')')) {
							runningOffset += line.length + 1;
							continue;
						}
						const localStart = line.search(/\S/);
						const startOffset = runningOffset + Math.max(0, localStart);
						const firstToken = localStart >= 0 ? line.slice(localStart).match(/^([A-Za-z_][\w-]*)/) : null;
						const tokLen = firstToken?.[1] ? firstToken[1].length : 1;
						diagnostics.push({
							range: toRange(lineStarts, startOffset, startOffset + tokLen),
							severity: KqlDiagnosticSeverity.Error,
							message: 'Unexpected text after a pipe operator. Did you forget to prefix this line with `|`?',
							code: 'KW_EXPECTED_PIPE',
							source: 'Kusto Workbench'
						});
					}
					runningOffset += line.length + 1;
				}
			}
		} catch {
			// ignore
		}

		// Column checks: best-effort pipeline simulation at top-level.
		if (tables.length && columnsByTable) {
			const isDynamicType = (t: unknown) => {
				const v = String(t ?? '').trim().toLowerCase();
				return v === 'dynamic' || v.includes('dynamic') || v === 'system.object' || v.includes('system.object') || v === 'object';
			};
			const getDynamicColumnsForTable = (table: string | null) => {
				const set = new Set<string>();
				if (!table || !columnTypesByTable) return set;
				const types = columnTypesByTable[table];
				if (!types || typeof types !== 'object') return set;
				for (const [col, typ] of Object.entries(types)) {
					if (isDynamicType(typ)) set.add(String(col));
				}
				return set;
			};
			const getDotChainRoot = (s: string, identStart: number): string | null => {
				// If current identifier is preceded by '.', walk left to find the leftmost identifier in the chain.
				let currentIdentStart = identStart;
				if (currentIdentStart <= 0 || s[currentIdentStart - 1] !== '.') return null;
				let root: string | null = null;
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

			const kw = new Set([
				'let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata',
				'where', 'project', 'extend', 'summarize', 'order', 'sort', 'by', 'take', 'top', 'distinct', 'join', 'from', 'on', 'kind', 'as',
				'asc', 'desc',
				'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith', 'between', 'matches', 'true', 'false', 'null', 'case', 'then', 'else'
			]);
			const fnNames = KNOWN_FUNCTION_NAMES;

			for (const st of sourceStatements) {
				const stmtText = st.maskedText;
				if (!stmtText.trim()) continue;
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;

				let activeTable: string | null = null;
				try {
					const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
					const lines = stmtText.split('\n');
					let statementLineOffset = 0;
					for (const line of lines) {
						const lineStartOffset = baseOffset + statementLineOffset;
						statementLineOffset += line.length + 1;
						const trimmed = line.trim();
						if (!trimmed) continue;
						if (trimmed.startsWith('|') || trimmed.startsWith('.') || trimmed.startsWith('//')) continue;
						const m = line.match(/^\s*([A-Za-z_][\w-]*)\b/);
						if (!m?.[1]) continue;
						const name = String(m[1]);
						if (ignore.has(name.toLowerCase())) continue;
						const found = tables.find((t) => sameLower(String(t), name));
						if (found && columnsByTable[found]) {
							activeTable = String(found);
							break;
						}
						const resolvedLet = resolveTabularLetToTable(
							name.toLowerCase(),
							lineStartOffset + Math.max(0, line.indexOf(name))
						);
						if (resolvedLet && columnsByTable[resolvedLet]) {
							activeTable = resolvedLet;
							break;
						}
					}
				} catch {
					activeTable = null;
				}

				let colSet: Set<string> | null = null;
				let dynamicRootCols = new Set<string>();
				if (activeTable) {
					colSet = new Set((columnsByTable[activeTable] || []).map((c) => String(c)));
					dynamicRootCols = getDynamicColumnsForTable(activeTable);
				}

				const currentColumns = () => (colSet ? Array.from(colSet) : []);
				const stmtTokens = scanTokens(stmtText);
				// Pipelines can appear at depth 1 inside `let ... { ... }` bodies.
				// Instead of hard-coding depth==0, validate at the shallowest pipeline depth in this statement.
				let pipelineDepth = Number.POSITIVE_INFINITY;
				for (const tok of stmtTokens) {
					if (tok?.type === 'pipe') pipelineDepth = Math.min(pipelineDepth, tok.depth);
				}
				if (!Number.isFinite(pipelineDepth)) continue;

				for (let i = 0; i < stmtTokens.length; i++) {
					const t = stmtTokens[i];
					if (!t || t.depth !== pipelineDepth || t.type !== 'pipe') continue;

					let opTok: Extract<Token, { type: 'ident' }> | null = null;
					for (let j = i + 1; j < stmtTokens.length; j++) {
						const tt = stmtTokens[j];
						if (!tt || tt.depth !== pipelineDepth) continue;
						if (tt.type === 'ident') {
							opTok = tt;
							break;
						}
						if (tt.type === 'pipe') break;
					}
					if (!opTok) continue;
					const op = String(opTok.value ?? '').toLowerCase();
					if (!colSet) continue;

					let clauseStart = opTok.endOffset;
					let clauseEnd = stmtText.length;
					for (let j = i + 1; j < stmtTokens.length; j++) {
						const tt = stmtTokens[j];
						if (!tt || tt.depth !== pipelineDepth) continue;
						if (tt.type === 'pipe' && tt.offset > opTok.offset) {
							clauseEnd = tt.offset;
							break;
						}
					}
					if (clauseStart >= clauseEnd) continue;
					const clauseText = stmtText.slice(clauseStart, clauseEnd);

					const inputColSet = colSet ? new Set(colSet) : null;
					let nextColSet: Set<string> | null = null;

					if (op === 'extend') {
						for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
							try {
								colSet.add(String(m[1]));
							} catch {
								// ignore
							}
						}
					}


					// Lightweight schema propagation for schema-combining operators.
					// Goal: any column introduced by the RHS of join/lookup should be in-scope after the operator.
					if (op === 'join' || op === 'lookup' || op === 'union') {
						const joinKindForStage = (stageText: string, defaultKind: string): string => {
							try {
								const mKind = String(stageText || '').match(/\bkind\s*=\s*([A-Za-z_][\w-]*)\b/i);
								return mKind?.[1] ? String(mKind[1]).toLowerCase() : defaultKind;
							} catch {
								return defaultKind;
							}
						};

						const joinOutputMode = (kindLower: string): 'left' | 'right' | 'both' => {
							const k = String(kindLower || '').toLowerCase();
							if (k === 'leftsemi' || k === 'leftanti' || k === 'anti' || k === 'leftantisemi') return 'left';
							if (k === 'rightsemi' || k === 'rightanti' || k === 'rightantisemi') return 'right';
							return 'both';
						};

						const addWithDedupe = (out: Set<string>, name: string): void => {
							try {
								const base = String(name);
								if (!base) return;
								if (!out.has(base)) {
									out.add(base);
									return;
								}
								// Kusto de-dupes right-side name conflicts automatically.
								let i = 1;
								while (out.has(`${base}${i}`)) i++;
								out.add(`${base}${i}`);
							} catch {
								// ignore
							}
						};

						const extractFirstParenGroup = (s: string): string | null => {
							try {
								const text = String(s || '');
								const open = text.indexOf('(');
								if (open < 0) return null;
								let depth = 0;
								for (let i = open; i < text.length; i++) {
									const ch = text[i];
									if (ch === '(') depth++;
									else if (ch === ')') {
										depth--;
										if (depth === 0) {
											return text.slice(open + 1, i);
										}
									}
								}
								return null;
							} catch {
								return null;
							}
						};

						const splitTopLevelCommaList = (s: string): string[] => {
							try {
								const text = String(s ?? '');
								const parts: string[] = [];
								let start = 0;
								let paren = 0;
								let bracket = 0;
								let brace = 0;
								let quote: '"' | "'" | null = null;
								for (let i = 0; i < text.length; i++) {
									const ch = text[i];
									if (quote) {
										if (ch === '\\') {
											i++;
											continue;
										}
										if (ch === quote) quote = null;
										continue;
									}
									if (ch === '"' || ch === "'") {
										quote = ch as '"' | "'";
										continue;
									}
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
							} catch {
								return [];
							}
						};

						// Map tabular let name -> RHS expression text (best-effort).
						const letExprByNameLower = new Map(
							analysis.letBindings
								.filter((binding) =>
									binding.kind === 'tabular' &&
									binding.scopeEndOffset === analysis.text.length &&
									binding.maskedRhsText.trim()
								)
								.map((binding) => [binding.nameLower, binding.maskedRhsText.trim()])
						);

						const inferColumnsForTabularExpr = (exprText: string, memo: Map<string, Set<string> | null>, stack: Set<string>): Set<string> | null => {
							try {
								const text = String(exprText ?? '').trim();
								if (!text) return null;

								// Simple identifier expression (table or let variable).
								const mIdent = text.match(/^([A-Za-z_][\w-]*)\b/);
								if (mIdent?.[1]) {
									const ident = String(mIdent[1]);
									const after = text.slice(mIdent[0].length);
									const afterTrim = after.trimStart();
									// If the next non-whitespace token is a pipe, this is a pipeline expression
									// starting with a table/let name (e.g. `T | summarize ...`). Handle via pipeline logic.
									if (!afterTrim.startsWith('(') && !afterTrim.startsWith('|')) {
										const found = tables.find((t) => sameLower(String(t), ident));
										if (found && columnsByTable[found]) {
											return new Set((columnsByTable[found] || []).map((c) => String(c)));
										}
										const key = ident.toLowerCase();
										if (memo.has(key)) return memo.get(key) || null;
										if (stack.has(key)) return null;
										stack.add(key);
										let result: Set<string> | null = null;
										const rhs = letExprByNameLower.get(key);
										if (rhs) {
											result = inferColumnsForTabularExpr(rhs, memo, stack);
										} else {
											// Fallback: treat as alias of its ultimate source table when we can't infer the RHS.
											const resolvedSimpleLet = resolveTabularLetToTable(key);
											if (resolvedSimpleLet && columnsByTable[resolvedSimpleLet]) {
												result = new Set((columnsByTable[resolvedSimpleLet] || []).map((c) => String(c)));
											}
										}
										stack.delete(key);
										memo.set(key, result);
										return result;
									}
								}

								// Pipeline expression: infer source + apply supported operators.
								let active: Set<string> | null = null;
								let activeTableLocal: string | null = null;
								try {
									const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
									const lines = text.split('\n');
									for (const line of lines) {
										const trimmed = String(line || '').trim();
										if (!trimmed || trimmed === ';') continue;
										if (trimmed.startsWith('|') || trimmed.startsWith('.') || trimmed.startsWith('//')) continue;
										const m = String(line || '').match(/^\s*([A-Za-z_][\w-]*)\b/);
										if (!m?.[1]) continue;
										const name = String(m[1]);
										if (ignore.has(name.toLowerCase())) continue;
										const found = tables.find((t) => sameLower(String(t), name));
										if (found && columnsByTable[found]) {
											activeTableLocal = String(found);
											break;
										}
										const resolvedLet = resolveTabularLetToTable(name.toLowerCase());
										if (resolvedLet && columnsByTable[resolvedLet]) {
											activeTableLocal = resolvedLet;
											break;
										}
										const memoKey = name.toLowerCase();
										const rhsCols = inferColumnsForTabularExpr(memoKey, memo, stack);
										if (rhsCols) {
											active = new Set(rhsCols);
											break;
										}
									}
								} catch {
									// ignore
								}
								if (!active && activeTableLocal) {
									active = new Set((columnsByTable[activeTableLocal] || []).map((c) => String(c)));
								}
								if (!active) return null;

								const localTokens = scanTokens(text);
								let pd = Number.POSITIVE_INFINITY;
								for (const tok of localTokens) {
									if (tok?.type === 'pipe') pd = Math.min(pd, tok.depth);
								}
								if (!Number.isFinite(pd)) return active;

								for (let i2 = 0; i2 < localTokens.length; i2++) {
									const t2 = localTokens[i2];
									if (!t2 || t2.depth !== pd || t2.type !== 'pipe') continue;
									let opTok2: Extract<Token, { type: 'ident' }> | null = null;
									for (let j2 = i2 + 1; j2 < localTokens.length; j2++) {
										const tt2 = localTokens[j2];
										if (!tt2 || tt2.depth !== pd) continue;
										if (tt2.type === 'ident') {
											opTok2 = tt2;
											break;
										}
										if (tt2.type === 'pipe') break;
									}
									if (!opTok2) continue;
									const op2 = String(opTok2.value ?? '').toLowerCase();
									let cs2 = opTok2.endOffset;
									let ce2 = text.length;
									for (let j2 = i2 + 1; j2 < localTokens.length; j2++) {
										const tt2 = localTokens[j2];
										if (!tt2 || tt2.depth !== pd) continue;
										if (tt2.type === 'pipe' && tt2.offset > opTok2.offset) {
											ce2 = tt2.offset;
											break;
										}
									}
												const ct2 = text.slice(cs2, ce2);
												const input2: Set<string> = new Set<string>(active);
									let next2: Set<string> | null = null;
									if (op2 === 'extend') {
										for (const m of ct2.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
											active.add(String(m[1]));
										}
									}
									if (op2 === 'project') {
										const next = new Set<string>();
										for (const m of ct2.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
											const nm = m[1];
											if (!nm) continue;
											const after = ct2.slice((m.index ?? 0) + nm.length);
											if (/^\s*=/.test(after)) {
												next.add(nm);
												continue;
											}
											if (input2.has(nm)) next.add(nm);
										}
										next2 = next;
									}
									if (op2 === 'summarize') {
										const next = new Set<string>();
										for (const m of ct2.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
											next.add(String(m[1]));
										}
										next2 = next;
									}
									if (op2 === 'join' || op2 === 'lookup') {
										const stage = text.slice(opTok2.offset, ce2);
										const defKind = (op2 === 'lookup') ? 'leftouter' : 'innerunique';
										const kind = joinKindForStage(stage, defKind);
										const mode = joinOutputMode(kind);
										let rightExpr = extractFirstParenGroup(stage);
										if (!rightExpr) {
											let afterOp = stage.replace(/^(join|lookup)\b/i, '').trim();
											afterOp = afterOp
												.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
												.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+/ig, ' ')
												.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
												.trim();
											const mName = afterOp.match(/^([A-Za-z_][\w-]*)\b/);
											rightExpr = mName?.[1] ? String(mName[1]) : null;
										}
										const rightCols = rightExpr ? inferColumnsForTabularExpr(rightExpr, memo, stack) : null;
										if (rightCols) {
											const out = new Set<string>();
											const leftOut = mode === 'right' ? null : input2;
											const rightOut = mode === 'left' ? null : rightCols;
											if (leftOut) for (const c of leftOut) addWithDedupe(out, c);
											if (rightOut) {
												// lookup doesn't repeat right-side key columns.
												let rightKeyExcludes = new Set<string>();
												if (op2 === 'lookup') {
													const onIdx = stage.toLowerCase().lastIndexOf(' on ');
													if (onIdx >= 0) {
														const onBody = stage.slice(onIdx + 4);
														// Collect $right.X keys, and simple `on Col` keys.
														for (const m of onBody.matchAll(/\$right\s*\.\s*([A-Za-z_][\w-]*)\b/gi)) {
															rightKeyExcludes.add(String(m[1]));
														}
														if (rightKeyExcludes.size === 0) {
															for (const part of splitTopLevelCommaList(onBody)) {
																const mKey = String(part || '').trim().match(/^([A-Za-z_][\w-]*)\b/);
																if (mKey?.[1]) rightKeyExcludes.add(String(mKey[1]));
															}
														}
													}
												}
												for (const c of rightOut) {
													if (rightKeyExcludes.has(String(c))) continue;
													addWithDedupe(out, c);
												}
											}
											next2 = out;
										}
									}
												if (op2 === 'union') {
										const stage = text.slice(opTok2.offset, ce2);
										const kind = joinKindForStage(stage, 'outer');
										const unionBody = stage.replace(/^union\b/i, '').trim();
										let withSourceCol: string | null = null;
										try {
											const mWs = unionBody.match(/\bwithsource\s*=\s*([A-Za-z_][\w-]*)\b/i);
											if (mWs?.[1]) withSourceCol = String(mWs[1]);
										} catch {
											// ignore
										}
										// Remove options before splitting legs.
										let legsText = unionBody
											.replace(/\bkind\s*=\s*(inner|outer)\b/ig, ' ')
											.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
											.replace(/\bisfuzzy\s*=\s*(true|false)\b/ig, ' ')
											.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+/ig, ' ')
											.trim();
										const legs = splitTopLevelCommaList(legsText);
										if (String(kind).toLowerCase() === 'inner') {
											// Be conservative: if we can't infer all legs, don't narrow.
											let ok = true;
														let acc: Set<string> = new Set<string>(input2);
											for (const leg of legs) {
												const cols = inferColumnsForTabularExpr(leg, memo, stack);
												if (!cols) {
													ok = false;
													break;
												}
															acc = new Set<string>(Array.from(acc).filter((c) => cols.has(c)));
											}
											if (ok) {
												next2 = acc;
															if (withSourceCol) addWithDedupe(acc, withSourceCol);
											}
										} else {
														const acc: Set<string> = new Set<string>(input2);
											for (const leg of legs) {
												const cols = inferColumnsForTabularExpr(leg, memo, stack);
												if (!cols) continue;
												for (const c of cols) addWithDedupe(acc, c);
											}
											next2 = acc;
														if (withSourceCol) addWithDedupe(acc, withSourceCol);
										}
									}
									if (next2) active = next2;
								}
								return active;
							} catch {
								return null;
							}
						};

						const memo = new Map<string, Set<string> | null>();
						const stack = new Set<string>();

						if (op === 'union') {
							// `T | union kind=... (Other) ...`
							const stage = stmtText.slice(opTok.offset, clauseEnd);
							const kind = joinKindForStage(stage, 'outer');
							let body = stage.replace(/^union\b/i, '').trim();
							let withSourceCol: string | null = null;
							try {
								const mWs = body.match(/\bwithsource\s*=\s*([A-Za-z_][\w-]*)\b/i);
								if (mWs?.[1]) withSourceCol = String(mWs[1]);
							} catch {
								// ignore
							}
							body = body
								.replace(/\bkind\s*=\s*(inner|outer)\b/ig, ' ')
								.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
								.replace(/\bisfuzzy\s*=\s*(true|false)\b/ig, ' ')
								.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+/ig, ' ')
								.trim();
							const legs = splitTopLevelCommaList(body);
							if (String(kind).toLowerCase() === 'inner') {
								let ok = true;
								let acc = new Set<string>(inputColSet || colSet);
								for (const leg of legs) {
									const cols = inferColumnsForTabularExpr(leg, memo, stack);
									if (!cols) {
										ok = false;
										break;
									}
									acc = new Set(Array.from(acc).filter((c) => cols.has(c)));
								}
								if (ok) {
									nextColSet = acc;
									if (withSourceCol) addWithDedupe(nextColSet, withSourceCol);
								}
							} else {
								const acc = new Set<string>(inputColSet || colSet);
								for (const leg of legs) {
									const cols = inferColumnsForTabularExpr(leg, memo, stack);
									if (!cols) continue;
									for (const c of cols) addWithDedupe(acc, c);
								}
								nextColSet = acc;
								if (withSourceCol) addWithDedupe(nextColSet, withSourceCol);
							}
						} else {
							const stage = stmtText.slice(opTok.offset, clauseEnd);
							const defKind = (op === 'lookup') ? 'leftouter' : 'innerunique';
							const kind = joinKindForStage(stage, defKind);
							const mode = joinOutputMode(kind);
							let rightExpr = extractFirstParenGroup(stage);
							if (!rightExpr) {
								let afterOp = stage.replace(/^(join|lookup)\b/i, '').trim();
								afterOp = afterOp
									.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
									.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+/ig, ' ')
									.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/ig, ' ')
									.trim();
								const mName = afterOp.match(/^([A-Za-z_][\w-]*)\b/);
								rightExpr = mName?.[1] ? String(mName[1]) : null;
							}
							const rightCols = rightExpr ? inferColumnsForTabularExpr(rightExpr, memo, stack) : null;
							if (rightCols) {
								const out = new Set<string>();
								const leftOut = mode === 'right' ? null : (inputColSet || colSet);
								const rightOut = mode === 'left' ? null : rightCols;
								if (leftOut) for (const c of leftOut) addWithDedupe(out, c);
								if (rightOut) {
									let rightKeyExcludes = new Set<string>();
									if (op === 'lookup') {
										const onIdx = stage.toLowerCase().lastIndexOf(' on ');
										if (onIdx >= 0) {
											const onBody = stage.slice(onIdx + 4);
											for (const m of onBody.matchAll(/\$right\s*\.\s*([A-Za-z_][\w-]*)\b/gi)) {
												rightKeyExcludes.add(String(m[1]));
											}
											if (rightKeyExcludes.size === 0) {
												for (const part of splitTopLevelCommaList(onBody)) {
													const mKey = String(part || '').trim().match(/^([A-Za-z_][\w-]*)\b/);
													if (mKey?.[1]) rightKeyExcludes.add(String(mKey[1]));
												}
											}
										}
									}
									for (const c of rightOut) {
										if (rightKeyExcludes.has(String(c))) continue;
										addWithDedupe(out, c);
									}
								}
								nextColSet = out;
							}
						}
					}
					if (op === 'project') {
						const next = new Set<string>();
						for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
							const name = m[1];
							if (!name) continue;
							const nl = name.toLowerCase();
							if (kw.has(nl)) continue;
							const after = clauseText.slice((m.index ?? 0) + name.length);
							if (/^\s*=/.test(after)) {
								next.add(name);
								continue;
							}
							if (inputColSet && inputColSet.has(name)) next.add(name);
						}
						nextColSet = next;
					}

					if (op === 'summarize') {
						const next = new Set<string>();
						try {
							let byTok: Extract<Token, { type: 'ident' }> | null = null;
							for (const tt of stmtTokens) {
								if (!tt || tt.depth !== pipelineDepth || tt.type !== 'ident') continue;
								if (tt.offset < clauseStart || tt.offset >= clauseEnd) continue;
								if (String(tt.value ?? '').toLowerCase() === 'by') byTok = tt;
							}
							if (byTok) {
								const byText = stmtText.slice(byTok.endOffset, clauseEnd);
								// Only include the *group key output columns*.
								// - `X = expr` => output `X`
								// - bare `Col` => output `Col`
								// - best-effort: `bin(Col, ...)` without alias => output `Col`
								const splitTopLevelCommaList = (s: string): string[] => {
									try {
										const text = String(s ?? '');
										const parts: string[] = [];
										let start = 0;
										let paren = 0;
										let bracket = 0;
										let brace = 0;
										let quote: '"' | "'" | null = null;
										for (let i = 0; i < text.length; i++) {
											const ch = text[i];
											if (quote) {
												if (ch === '\\') {
													i++;
													continue;
												}
												if (ch === quote) {
													quote = null;
												}
												continue;
											}
											if (ch === '"' || ch === "'") {
												quote = ch;
												continue;
											}
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
									} catch {
										return [];
									}
								};
								for (const item of splitTopLevelCommaList(byText)) {
									const mAssign = item.match(/^([A-Za-z_][\w-]*)\s*=/);
									if (mAssign?.[1]) {
										next.add(String(mAssign[1]));
										continue;
									}
									const mBare = item.match(/^([A-Za-z_][\w-]*)\s*$/);
									if (mBare?.[1]) {
										const name = String(mBare[1]);
										if (!inputColSet || inputColSet.has(name)) next.add(name);
										continue;
									}
									const mBin = item.match(/^bin\s*\(\s*([A-Za-z_][\w-]*)\b/i);
									if (mBin?.[1]) {
										const name = String(mBin[1]);
										if (!inputColSet || inputColSet.has(name)) next.add(name);
										continue;
									}
								}
							}
						} catch {
							// ignore
						}
						for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
							try {
								next.add(String(m[1]));
							} catch {
								// ignore
							}
						}
						nextColSet = next;
					}

					if (nextColSet) {
						colSet = nextColSet;
					}

					const shouldValidateColumns =
						op === 'where' || op === 'project' || op === 'extend' || op === 'summarize' || op === 'distinct' || op === 'take' || op === 'top' || op === 'order' || op === 'sort';
					if (!shouldValidateColumns) continue;

					const validateSet = op === 'project' || op === 'summarize' ? (inputColSet || colSet) : colSet;
					for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
						const name = m[1];
						if (!name) continue;
						const nl = name.toLowerCase();
						if (kw.has(nl)) continue;
						if (fnNames.has(nl)) continue;

						try {
							const localIndex = typeof m.index === 'number' ? m.index : 0;
							const root = getDotChainRoot(clauseText, localIndex);
							if (root && validateSet && validateSet.has(root) && dynamicRootCols.has(root)) {
								continue;
							}
						} catch {
							// ignore
						}

						// Only skip assignment LHS for operators that actually assign/rename columns.
						// In `where`, `Name = 'x'` is a comparison and must still validate `Name`.
						if (op === 'extend' || op === 'project' || op === 'summarize') {
							try {
								const afterLocal = clauseText.slice((typeof m.index === 'number' ? m.index : 0) + name.length);
								if (/^\s*=/.test(afterLocal)) continue;
							} catch {
								// ignore
							}
						}

						const absoluteOffset = baseOffset + clauseStart + (typeof m.index === 'number' ? m.index : 0);
						if (isKqlNameInScope(analysis, nl, absoluteOffset)) continue;
						try {
							const after = rawForParse.slice(absoluteOffset + name.length, Math.min(rawForParse.length, absoluteOffset + name.length + 6));
							if (/^\s*\(/.test(after)) continue;
						} catch {
							// ignore
						}

						if (validateSet && !validateSet.has(name)) {
							reportUnknown('KW_UNKNOWN_COLUMN', 'column', name, absoluteOffset, absoluteOffset + name.length, currentColumns());
						}
					}
				}
			}
		}

		return diagnostics;
	}
}
