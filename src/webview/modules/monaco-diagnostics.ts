// Monaco diagnostics module - extracted from monaco.ts (Phase 6 decomposition).
// KQL diagnostics engine (DISABLED - monaco-kusto handles validation).
// Also contains text-processing utility functions used by completions and other modules.
// Window bridge exports at bottom for remaining callers.

import { queryEditorBoxByModelUri, activeQueryEditorBoxId, schemaByBoxId } from './state';

const _win = window;

// AMD globals loaded by require() - available globally after Monaco loads.
// Only used by disabled diagnostics code (not called at runtime).
declare const monaco: any;

// -- Dependencies from other modules (DISABLED code only) --
// These are never accessed at runtime because the diagnostics engine is disabled.
// Declared here so the moved code compiles without changes.
let KUSTO_FUNCTION_DOCS: any;
let __kustoProvideCompletionItemsForDiagnostics: any;

// --- Live diagnostics (markers) + quick fixes ---
const KUSTO_DIAGNOSTICS_OWNER = 'kusto-diagnostics';

export const __kustoMaskCommentsPreserveLayout = (text: any) => {
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

export const __kustoClamp = (n: any, min: any, max: any) => Math.max(min, Math.min(max, n));

export const __kustoSplitTopLevelStatements = (text: any) => {
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

export const __kustoSplitPipelineStagesDeep = (text: any) => {
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

export const __kustoFindLastTopLevelPipeBeforeOffset = (text: any, offset: any) => {
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

export const __kustoGetActivePipeStageInfoBeforeOffset = (stmtText: any, offsetInStmt: any) => {
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

export const __kustoParsePipeHeaderFromLine = (trimmedPipeLine: any) => {
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

export const __kustoPipeHeaderAllowsIndentedContinuation = (pipeHeader: any) => {
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

export const __kustoGetStatementStartAtOffset = (text: any, offset: any) => {
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

export const __kustoBuildLineStarts = (text: any) => {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
};

export const __kustoOffsetToPosition = (lineStarts: any, offset: any) => {
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

export const __kustoIsIdentStart = (ch: any) => {
	return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95; // A-Z a-z _
};
export const __kustoIsIdentPart = (ch: any) => {
	return __kustoIsIdentStart(ch) || (ch >= 48 && ch <= 57) || ch === 45; // 0-9 -
};

export const __kustoScanIdentifiers = (text: any) => {
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

/** Parse a fully-qualified table expression like `cluster('url').database('db').TableName`. */
export const __kustoParseFullyQualifiedTableExpr = (text: any) => {
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

/** Extract the source table name (lowercased) from a let RHS expression. */
export const __kustoExtractSourceLower = (rhsText: any) => {
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

/** Split text by commas at top level (respecting parens, brackets, braces, quotes). */
export const __kustoSplitTopLevelCommaList = (s: any) => {
	try {
		const text = String(s || '');
		const parts: string[] = [];
		let start = 0;
		let paren = 0, bracket = 0, brace = 0;
		let quote: string | null = null;
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

/** Walk backwards from an identifier through dot-chains to find the root column. */
export const __kustoGetDotChainRoot = (s: any, identStart: any) => {
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

/** Extract the right-side table name from a join, lookup, or from clause. */
export const __kustoExtractJoinTable = (seg: any) => {
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

export const __kustoLevenshtein = (a: any, b: any) => {
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

export const __kustoBestMatches = (needle: any, candidates: any, maxCount: any) => {
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
		boxId = model && model.uri ? (queryEditorBoxByModelUri[model.uri.toString()] || null) : null;
	} catch { boxId = null; }
	if (!boxId) {
		boxId = activeQueryEditorBoxId;
	}
	return { boxId, schema: boxId ? (schemaByBoxId[boxId] || null) : null };
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
				} catch (e) { console.error('[kusto]', e); }
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
	} catch (e) { console.error('[kusto]', e); }

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
		} catch (e) { console.error('[kusto]', e); }
		const letSources: any = {};
		const extractSourceLower = __kustoExtractSourceLower;
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
		} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }

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
									} catch (e) { console.error('[kusto]', e); }
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
											} catch (e) { console.error('[kusto]', e); }
											const mSrc = rhs.match(/^([A-Za-z_][\w-]*)\b/);
											if (!mSrc || !mSrc[1]) return { handled: true, ok: true };
											const srcName = String(mSrc[1]);
											// Ignore scalar function calls: datetime(...), now(), etc.
											try {
												const after = rhs.slice(mSrc[0].length);
												if (/^\s*\(/.test(after)) return { handled: true, ok: true };
											} catch (e) { console.error('[kusto]', e); }
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
						} catch (e) { console.error('[kusto]', e); }
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
		} catch (e) { console.error('[kusto]', e); }

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
		} catch (e) { console.error('[kusto]', e); }

		try {
			const extractJoinOrLookupRightTable = __kustoExtractJoinTable;

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
										} catch (e) { console.error('[kusto]', e); }
					if (__kustoDeclaredLetNames.has(String(name).toLowerCase())) continue;
					try {
						const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
						const startOffset = baseOffset + idx + Math.max(0, localStart);
						if (__kustoIsTabularParamInScope(String(name).toLowerCase(), startOffset)) {
							continue;
						}
					} catch (e) { console.error('[kusto]', e); }
				if (__kustoResolveTabularLetToTable(String(name).toLowerCase())) continue;
				if (tables.length && !tables.some((t: any) => String(t).toLowerCase() === String(name).toLowerCase())) {
					const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
					const startOffset = baseOffset + idx + Math.max(0, localStart);
					reportUnknownName('KW_UNKNOWN_TABLE', name, startOffset, startOffset + String(name).length, __kustoTabularNameCandidates, 'table');
				}
			}
		} catch (e) { console.error('[kusto]', e); }
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
		const getDotChainRoot = __kustoGetDotChainRoot;
		const letNames = new Set();
		try {
			for (const m of raw.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
				if (m && m[2]) letNames.add(String(m[2]).toLowerCase());
			}
		} catch (e) { console.error('[kusto]', e); }

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
			} catch (e) { console.error('[kusto]', e); }
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
					try { colSet.add(m[1]); } catch (e) { console.error('[kusto]', e); }
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
							for (const item of __kustoSplitTopLevelCommaList(byText)) {
								const mAssign = String(item || '').match(/^([A-Za-z_][\w-]*)\s*=/);
								if (mAssign && mAssign[1]) { next.add(String(mAssign[1])); continue; }
								const mBare = String(item || '').match(/^([A-Za-z_][\w-]*)\s*$/);
								if (mBare && mBare[1]) { const name = String(mBare[1]); if (!inputColSet || inputColSet.has(name)) next.add(name); continue; }
								const mBin = String(item || '').match(/^bin\s*\(\s*([A-Za-z_][\w-]*)\b/i);
								if (mBin && mBin[1]) { const name = String(mBin[1]); if (!inputColSet || inputColSet.has(name)) next.add(name); continue; }
							}
					}
				} catch (e) { console.error('[kusto]', e); }
				// assigned aggregates
				for (const m of clauseText.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) {
					try { next.add(m[1]); } catch (e) { console.error('[kusto]', e); }
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
						} catch (e) { console.error('[kusto]', e); }
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
				} catch (e) { console.error('[kusto]', e); }
				// Allow `dynamicColumn.any.property.chain` when the root is a known dynamic column.
				try {
					const localIndex = (typeof m.index === 'number') ? m.index : 0;
					const root = getDotChainRoot(clauseText, localIndex);
					if (root && validateSet && validateSet.has(root) && dynamicRootCols.has(root)) {
						continue;
					}
				} catch (e) { console.error('[kusto]', e); }
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
export function __kustoScheduleKustoDiagnostics(boxId: any, delayMs: any) {
	// Monaco-kusto provides its own diagnostics/validation, so this is now a no-op.
	return;
}

// Window bridges removed (D8) — all utility functions exported at top, consumed via ES imports.
