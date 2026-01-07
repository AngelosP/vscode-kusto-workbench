import { DatabaseSchemaIndex } from '../kustoClient';
import { KqlDiagnostic, KqlDiagnosticSeverity, type KqlPosition, type KqlRange, type KqlTableReference } from './protocol';
import { getColumnsByTable } from '../schemaIndexUtils';

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

const isDotCommandStatement = (stmtText: string): boolean => {
	try {
		const s = String(stmtText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		let i = 0;
		while (i < s.length) {
			// whitespace
			while (i < s.length && /\s/.test(s[i]!)) i++;
			if (i >= s.length) return false;
			// line comment
			if (s[i] === '/' && s[i + 1] === '/') {
				i = s.indexOf('\n', i + 2);
				if (i < 0) return false;
				continue;
			}
			// block comment
			if (s[i] === '/' && s[i + 1] === '*') {
				const end = s.indexOf('*/', i + 2);
				if (end < 0) return false;
				i = end + 2;
				continue;
			}
			return s[i] === '.';
		}
		return false;
	} catch {
		return false;
	}
};

type TextRange = { start: number; end: number };

const buildCommentRanges = (text: string): TextRange[] => {
	const raw = String(text ?? '');
	const ranges: TextRange[] = [];
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	let rangeStart = -1;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const next = raw[i + 1];
		if (inLineComment) {
			if (ch === '\n') {
				ranges.push({ start: rangeStart, end: i });
				inLineComment = false;
				rangeStart = -1;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				ranges.push({ start: rangeStart, end: i + 2 });
				inBlockComment = false;
				rangeStart = -1;
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

		if (ch === '/' && next === '/') {
			inLineComment = true;
			rangeStart = i;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			rangeStart = i;
			i++;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
	}
	// If we ended inside a comment, close it at EOF.
	if (inLineComment && rangeStart >= 0) {
		ranges.push({ start: rangeStart, end: raw.length });
	}
	if (inBlockComment && rangeStart >= 0) {
		ranges.push({ start: rangeStart, end: raw.length });
	}
	return ranges;
};

// Replace comment *contents* with spaces while preserving newlines and offsets.
// This lets us run lightweight tokenization/string scanning without comments ever affecting
// parsing, while keeping diagnostic ranges valid.
const maskCommentsPreserveLayout = (text: string): string => {
	const s = String(text ?? '');
	if (!s) return s;
	const out: string[] = new Array(s.length);
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		const next = s[i + 1];

		if (inLineComment) {
			if (ch === '\n') {
				out[i] = ch;
				inLineComment = false;
			} else {
				// Preserve the leading //, but mask the comment body.
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
			out[i] = ch === '\n' ? ch : ' ';
			continue;
		}
		if (inSingle) {
			out[i] = ch;
			if (ch === "'") {
				// Kusto escape for single quotes: ''
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

		// Enter comments (only when not inside strings)
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
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
	}
	return out.join('');
};

const isInRanges = (ranges: TextRange[], offset: number): boolean => {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = ranges[mid];
		if (offset < r.start) {
			hi = mid - 1;
			continue;
		}
		if (offset >= r.end) {
			lo = mid + 1;
			continue;
		}
		return true;
	}
	return false;
};

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
		// line comment
		if (ch === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
			while (i < text.length && text.charCodeAt(i) !== 10) i++;
			continue;
		}
		// block comment
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
		// strings
		if (ch === 39 /* ' */ || ch === 34 /* \" */) {
			const quote = ch;
			i++;
			while (i < text.length) {
				const c = text.charCodeAt(i);
				if (c === quote) {
					// Kusto single quote escaping: ''
					if (quote === 39 && text.charCodeAt(i + 1) === 39) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				// basic escape in double quotes
				if (quote === 34 && c === 92 /* \\ */) {
					i += 2;
					continue;
				}
				i++;
			}
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

type TextStatement = { startOffset: number; text: string };

const splitTopLevelStatements = (text: string): TextStatement[] => {
	const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const out: TextStatement[] = [];
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
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}

		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			continue;
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			depth = Math.max(0, depth - 1);
			continue;
		}

		if (ch === ';' && depth === 0) {
			out.push({ startOffset: start, text: raw.slice(start, i) });
			start = i + 1;
			continue;
		}

		// Blank-line separator: treat one-or-more blank lines as a statement boundary.
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
	return out.filter((s) => String(s.text || '').trim().length > 0);
};

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

export class KqlLanguageService {
	findTableReferences(text: string): KqlTableReference[] {
		const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		if (!raw.trim()) {
			return [];
		}

		// Collect declared `let` names so we don't treat them as tables.
		const letDeclaredNames = new Set<string>();
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
				const m = stmt.match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*[\s\S]*?(;|$)/i);
				if (!m?.[1]) continue;
				letDeclaredNames.add(String(m[1]).toLowerCase());
			}
		} catch {
			// ignore
		}

		const ignoreLeading = new Set([
			'let',
			'set',
			'declare',
			'print',
			'range',
			'datatable',
			'externaldata'
		]);

		const refs: KqlTableReference[] = [];
		const seen = new Set<string>();
		const addRef = (name: string, startOffset: number, endOffset: number) => {
			const n = String(name || '');
			if (!n) return;
			const key = `${startOffset}:${endOffset}`;
			if (seen.has(key)) return;
			seen.add(key);
			refs.push({ name: n, startOffset, endOffset });
		};

		const isQualifiedAt = (s: string, start: number): boolean => {
			let p = start - 1;
			while (p >= 0 && s[p] === ' ') p--;
			return p >= 0 && s[p] === '.';
		};

		const isFunctionCallAt = (s: string, end: number): boolean => {
			let i = end;
			while (i < s.length && s[i] === ' ') i++;
			return s[i] === '(';
		};

		// Leading tabular source in each statement.
		try {
			const statements = splitTopLevelStatements(raw);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				const lines = stmtText.split('\n');
				let runningOffset = baseOffset;
				let statementHasLeadingId = false;
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === ';') {
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
					const m = line.match(/^\s*([A-Za-z_][\w-]*)\b/);
					if (m?.[1]) {
						const name = String(m[1]);
						const lower = name.toLowerCase();
						const localStart = line.indexOf(name);
						if (localStart >= 0) {
							const absStart = runningOffset + localStart;
							const absEnd = absStart + name.length;
							if (!ignoreLeading.has(lower) && !letDeclaredNames.has(lower)) {
								if (!isQualifiedAt(raw, absStart) && !isFunctionCallAt(raw, absEnd)) {
									addRef(name, absStart, absEnd);
								}
							}
						}
						statementHasLeadingId = true;
					}
					runningOffset += line.length + 1;
				}
			}
		} catch {
			// ignore
		}

		// join/lookup/from right-hand table.
		try {
			const parseRightTableAt = (seg: string, segGlobalStart: number, keyword: 'join' | 'lookup' | 'from'): { name: string; start: number; end: number } | null => {
				const isIdentStartCh = (ch: string) => /[A-Za-z_]/.test(ch);
				const isIdentPartCh = (ch: string) => /[A-Za-z0-9_\-]/.test(ch);
				const skipWs = (s: string, i: number) => {
					while (i < s.length && /\s/.test(s[i])) i++;
					return i;
				};

				let pos = 0;
				pos = skipWs(seg, pos);
				// keyword
				if (keyword === 'from') {
					if (!/^from\b/i.test(seg.slice(pos))) return null;
					pos += 4;
				} else {
					if (!new RegExp(`^${keyword}\\b`, 'i').test(seg.slice(pos))) return null;
					pos += keyword.length;
				}
				pos = skipWs(seg, pos);

				const eatOption = (re: RegExp) => {
					const m = seg.slice(pos).match(re);
					if (!m || m.index !== 0) return false;
					pos += m[0].length;
					pos = skipWs(seg, pos);
					return true;
				};

				if (keyword === 'join' || keyword === 'lookup') {
					// zero or more options
					// kind=...
					while (
						eatOption(/^kind\s*=\s*[A-Za-z_][\w-]*\b/i) ||
						eatOption(/^hint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+/i) ||
						eatOption(/^withsource\s*=\s*[A-Za-z_][\w-]*\b/i)
					) {
						// keep consuming
					}
				}

				// Parenthesized right table: (RightTable)
				pos = skipWs(seg, pos);
				if (seg[pos] === '(') {
					const close = seg.indexOf(')', pos + 1);
					if (close > pos + 1) {
						const inner = seg.slice(pos + 1, close);
						const innerWs = inner.match(/^\s*/)?.[0]?.length ?? 0;
						const innerTrimmed = inner.slice(innerWs);
						const mName = innerTrimmed.match(/^([A-Za-z_][\w-]*)\b/);
						if (mName?.[1]) {
							const name = String(mName[1]);
							const start = segGlobalStart + pos + 1 + innerWs;
							return { name, start, end: start + name.length };
						}
					}
					return null;
				}

				// Next token should be a simple identifier.
				if (!isIdentStartCh(seg[pos] || '')) {
					return null;
				}
				let end = pos + 1;
				while (end < seg.length && isIdentPartCh(seg[end])) end++;
				const name = seg.slice(pos, end);
				const after = skipWs(seg, end);
				// Skip qualified patterns like database('x').Table (function call) and cluster(...)
				if (seg[after] === '(') {
					return null;
				}
				const start = segGlobalStart + pos;
				return { name, start, end: start + name.length };
			};

			const statements = splitTopLevelStatements(raw);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				for (const m of stmtText.matchAll(/\b(join|lookup|from)\b/gi)) {
					const kw = String(m[1] || '').toLowerCase();
					const idx = typeof m.index === 'number' ? m.index : -1;
					if (idx < 0) continue;
					let endLine = stmtText.indexOf('\n', idx);
					if (endLine < 0) endLine = stmtText.length;
					const seg = stmtText.slice(idx, endLine);
					const parsed =
						kw === 'from'
							? parseRightTableAt(seg, baseOffset + idx, 'from')
							: parseRightTableAt(seg, baseOffset + idx, kw as 'join' | 'lookup');
					if (!parsed) continue;
					const lower = parsed.name.toLowerCase();
					if (letDeclaredNames.has(lower)) continue;
					if (!isQualifiedAt(raw, parsed.start) && !isFunctionCallAt(raw, parsed.end)) {
						addRef(parsed.name, parsed.start, parsed.end);
					}
				}
			}
		} catch {
			// ignore
		}

		refs.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
		return refs;
	}

	getDiagnostics(text: string, schema: DatabaseSchemaIndex | undefined | null): KqlDiagnostic[] {
		const diagnostics: KqlDiagnostic[] = [];
		const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		const rawForParse = maskCommentsPreserveLayout(raw);
		if (!raw.trim()) {
			return diagnostics;
		}

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

		type LetSource = { nameLower: string; sourceLower: string };
		const letTabularSources: LetSource[] = [];
		const letDeclaredNames = new Set<string>();
		const letDeclaredNamesByLower = new Map<string, string>();
		const extractTabularSourceLower = (rhsText: string): string | null => {
			const rhs = String(rhsText ?? '').trim();
			if (!rhs) return null;
			// cluster('X').database('Y').Table
			try {
				const m = rhs.match(/\bcluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
				if (m?.[1]) return String(m[1]).toLowerCase();
			} catch {
				// ignore
			}
			// database('Y').Table
			try {
				const m = rhs.match(/\bdatabase\s*\([^)]*\)\s*\.\s*([A-Za-z_][\w-]*)\b/i);
				if (m?.[1]) return String(m[1]).toLowerCase();
			} catch {
				// ignore
			}
			// fall back: first identifier
			try {
				const m = rhs.replace(/^\(\s*/g, '').trim().match(/^([A-Za-z_][\w-]*)\b/);
				return m?.[1] ? String(m[1]).toLowerCase() : null;
			} catch {
				return null;
			}
		};
		const resolveTabularLetToTable = (nameLower: string): string | null => {
			let cur = String(nameLower || '').toLowerCase();
			for (let depth = 0; depth < 8; depth++) {
				const direct = tablesByLower.get(cur);
				if (direct) return direct;
				const next = letTabularSources.find((x) => x.nameLower === cur)?.sourceLower;
				if (!next) return null;
				cur = next;
			}
			return null;
		};
		try {
			const lines = rawForParse.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const trimmed = lines[i].trim();
				if (!/^let\s+/i.test(trimmed)) continue;
				let stmt = lines[i];
				while (i + 1 < lines.length && stmt.indexOf(';') === -1) {
					i++;
					stmt += '\n' + lines[i];
				}
				const m = stmt.match(/^\s*let\s+([A-Za-z_][\w-]*)\s*=\s*([\s\S]*?)(;|$)/i);
				if (!m?.[1] || !m?.[2]) continue;
				const letNameLower = String(m[1]).toLowerCase();
				letDeclaredNames.add(letNameLower);
				if (!letDeclaredNamesByLower.has(letNameLower)) {
					letDeclaredNamesByLower.set(letNameLower, String(m[1]));
				}
				let rhs = String(m[2]).trim();
				const sourceLower = extractTabularSourceLower(rhs);
				if (!sourceLower) continue;
				letTabularSources.push({ nameLower: letNameLower, sourceLower });
			}
		} catch {
			// ignore
		}

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

		// Tabular parameters inside user-defined functions should behave like valid table variables
		// within the function body, e.g.
		//   let f = (T:(col:type)) { T | summarize ... };
		type TabularParamScope = { startOffset: number; endOffset: number; namesLower: Set<string> };
		const tabularParamScopes: TabularParamScope[] = (() => {
			try {
				const scopes: TabularParamScope[] = [];
				const s = rawForParse;
				const re = /(^|\n)\s*let\s+[A-Za-z_][\w-]*\s*=\s*\(/gi;
				for (const m of s.matchAll(re)) {
					const idx = typeof m.index === 'number' ? m.index : -1;
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
					const namesLower = new Set<string>();
					for (const pm of paramText.matchAll(/([A-Za-z_][\w-]*)\s*:\s*\(/g)) {
						if (pm?.[1]) namesLower.add(String(pm[1]).toLowerCase());
					}
					if (!namesLower.size) continue;

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
					scopes.push({ startOffset: bodyStart + 1, endOffset: bodyEnd - 1, namesLower });
				}
				return scopes;
			} catch {
				return [];
			}
		})();

		const isTabularParamInScope = (nameLower: string, offset: number): boolean => {
			try {
				const n = String(nameLower || '').toLowerCase();
				const off = Number(offset) || 0;
				for (const sc of tabularParamScopes) {
					if (off >= sc.startOffset && off <= sc.endOffset && sc.namesLower.has(n)) return true;
				}
				return false;
			} catch {
				return false;
			}
		};

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

		// Unknown table checks: statement-leading identifier.
		try {
			const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
			const tryExtractTabularSourceFromLet = (line: string, nextNonPipeLine: string | null): string | null => {
				try {
					const s = String(line || '');
					if (!/^\s*let\s+/i.test(s)) {
						return null;
					}
					const eqIdx = s.indexOf('=');
					let rhs = '';
					if (eqIdx >= 0) {
						rhs = s.slice(eqIdx + 1);
					}
					rhs = String(rhs || '').trim();
					if (!rhs && nextNonPipeLine) {
						rhs = String(nextNonPipeLine).trim();
					}
					if (!rhs) {
						return null;
					}
					// Fully-qualified sources are considered valid and not validated against current schema.
					if (/\bcluster\s*\(\s*'[^']+'\s*\)\s*\.\s*database\s*\(\s*'[^']+'\s*\)\s*\.\s*[A-Za-z_][\w-]*\b/i.test(rhs)) {
						return null;
					}
					const m = rhs.match(/^([A-Za-z_][\w-]*)\b/);
					if (!m?.[1]) {
						return null;
					}
					const name = String(m[1]);
					// Ignore scalar function calls: datetime(...)
					try {
						const after = rhs.slice(m[0].length);
						if (/^\s*\(/.test(after)) {
							return null;
						}
					} catch {
						// ignore
					}
					return name;
				} catch {
					return null;
				}
			};
			const isFullyQualifiedTableExpr = (line: string): boolean => {
				try {
					return /\bcluster\s*\(\s*'[^']+'\s*\)\s*\.\s*database\s*\(\s*'[^']+'\s*\)\s*\.\s*[A-Za-z_][\w-]*\b/i.test(String(line || ''));
				} catch {
					return false;
				}
			};
			const statements = splitTopLevelStatements(rawForParse);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: rawForParse }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				const lines = stmtText.split('\n');
				let runningOffset = baseOffset;
				let statementHasLeadingId = false;
				for (let li = 0; li < lines.length; li++) {
					const line = lines[li];
					const trimmed = line.trim();
					if (!trimmed || trimmed === ';') {
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
					// Fully-qualified tabular expressions should not be treated as an unqualified table name.
					if (isFullyQualifiedTableExpr(line)) {
						statementHasLeadingId = true;
						runningOffset += line.length + 1;
						continue;
					}
					const m = line.match(/^\s*([A-Za-z_][\w-]*)\b/);
					if (m?.[1]) {
						const name = m[1];
						const nameLower = name.toLowerCase();
						if (!ignore.has(nameLower)) {
							// A declared `let` identifier is valid even if we can't resolve it to schema.
							if (letDeclaredNames.has(String(name).toLowerCase())) {
								statementHasLeadingId = true;
								runningOffset += line.length + 1;
								continue;
							}
								// Tabular function parameters are valid table variables within the function body.
								if (isTabularParamInScope(nameLower, runningOffset + Math.max(0, line.indexOf(name)))) {
									statementHasLeadingId = true;
									runningOffset += line.length + 1;
									continue;
								}
							const resolvedLet = resolveTabularLetToTable(String(name).toLowerCase());
							if (resolvedLet) {
								statementHasLeadingId = true;
								runningOffset += line.length + 1;
								continue;
							}
							if (tables.length && !tables.some((t) => sameLower(String(t), name))) {
								const localStart = line.indexOf(name);
								if (localStart >= 0) {
									reportUnknown('KW_UNKNOWN_TABLE', 'table', name, runningOffset + localStart, runningOffset + localStart + name.length, tabularNameCandidates);
								}
							}
						} else if (nameLower === 'let') {
							// For `let X = <tabular>`, validate the RHS source (supports multiline `let X =` newline `Table`).
							let nextNonPipe: string | null = null;
							for (let k = li + 1; k < lines.length; k++) {
								const t2 = String(lines[k] || '').trim();
								if (!t2) {
									continue;
								}
								if (t2 === ';') {
									continue;
								}
								if (t2.startsWith('|') || t2.startsWith('.') || t2.startsWith('//')) {
									continue;
								}
								nextNonPipe = lines[k];
								break;
							}
							const rhsTable = tryExtractTabularSourceFromLet(line, nextNonPipe);
							if (rhsTable) {
								const rhsLower = rhsTable.toLowerCase();
								if (letDeclaredNames.has(rhsLower)) {
									statementHasLeadingId = true;
									runningOffset += line.length + 1;
									continue;
								}
								const resolvedLet = resolveTabularLetToTable(rhsLower);
								if (resolvedLet) {
									statementHasLeadingId = true;
									runningOffset += line.length + 1;
									continue;
								}
								if (tables.length && !tables.some((t) => sameLower(String(t), rhsTable))) {
									const localStart = line.toLowerCase().indexOf(rhsLower);
									if (localStart >= 0) {
										reportUnknown('KW_UNKNOWN_TABLE', 'table', rhsTable, runningOffset + localStart, runningOffset + localStart + rhsTable.length, tabularNameCandidates);
									}
								}
								statementHasLeadingId = true;
							} else {
								// Scalar `let` (e.g. let d = datetime(...)) – don't block the next line in multiline formats.
								statementHasLeadingId = false;
							}
						}
						if (nameLower !== 'let') {
							statementHasLeadingId = true;
						}
					}
					runningOffset += line.length + 1;
				}
			}
		} catch {
			// ignore
		}

		// Unknown table checks: join/from/lookup.
		try {
			const isFullyQualifiedTableExpr = (seg: string): boolean => {
				try {
					return /\bcluster\s*\(\s*'[^']+'\s*\)\s*\.\s*database\s*\(\s*'[^']+'\s*\)\s*\.\s*[A-Za-z_][\w-]*\b/i.test(String(seg || ''));
				} catch {
					return false;
				}
			};
			const extractJoinOrLookupRightTable = (seg: string): string | null => {
				try {
					// Prefer (RightTable)
					const paren = seg.match(/\(([^)]*)\)/);
					if (paren?.[1]) {
						const mName = String(paren[1]).trim().match(/^([A-Za-z_][\w-]*)\b/);
						if (mName?.[1]) return mName[1];
					}
					// While typing the subquery, the closing ')' may not exist yet.
					const openParen = seg.match(/\(\s*([A-Za-z_][\w-]*)\b/);
					if (openParen?.[1]) return openParen[1];
					const afterOp = String(seg).replace(/^(join|lookup)\b/i, '').trim();
					const withoutOpts = afterOp
						.replace(/\bkind\s*=\s*[A-Za-z_][\w-]*\b/gi, ' ')
						.replace(/\bhint\.[A-Za-z_][\w-]*\s*=\s*[^ \t\r\n)]+/gi, ' ')
						.replace(/\bwithsource\s*=\s*[A-Za-z_][\w-]*\b/gi, ' ')
						.trim();
					const mName = withoutOpts.match(/^([A-Za-z_][\w-]*)\b/);
					return mName?.[1] ? mName[1] : null;
				} catch {
					return null;
				}
			};

			const statements = splitTopLevelStatements(rawForParse);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: rawForParse }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				for (const m of stmtText.matchAll(/\b(join|lookup|from)\b/gi)) {
					const kw = String(m[1] || '').toLowerCase();
					const idx = typeof m.index === 'number' ? m.index : -1;
					if (idx < 0) continue;
					let end = stmtText.indexOf('\n', idx);
					if (end < 0) end = stmtText.length;
					const seg = stmtText.slice(idx, end);
					let name: string | null = null;
					if (kw === 'from') {
						const mm = seg.match(/^from\s+([A-Za-z_][\w-]*)\b/i);
						name = mm?.[1] ? mm[1] : null;
					} else {
						name = extractJoinOrLookupRightTable(seg);
					}
					if (!name) continue;
					// Fully-qualified sources (cluster().database().Table) should not be validated against current DB schema.
					if (isFullyQualifiedTableExpr(seg)) continue;
					if (letDeclaredNames.has(String(name).toLowerCase())) continue;
					try {
						const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
						const startOffset = baseOffset + idx + Math.max(0, localStart);
						if (isTabularParamInScope(String(name).toLowerCase(), startOffset)) continue;
					} catch {
						// ignore
					}
					if (resolveTabularLetToTable(String(name).toLowerCase())) continue;
					if (tables.length && !tables.some((t) => sameLower(String(t), name))) {
						const localStart = seg.toLowerCase().indexOf(String(name).toLowerCase());
						const startOffset = baseOffset + idx + Math.max(0, localStart);
						reportUnknown('KW_UNKNOWN_TABLE', 'table', name, startOffset, startOffset + String(name).length, tabularNameCandidates);
					}
				}
			}
		} catch {
			// ignore
		}

		// Basic syntax-ish check: once a statement has started piping, any subsequent non-empty line
		// should either start with '|' or be an indented continuation of a multiline operator (e.g. summarize, where).
		try {
			const statements = splitTopLevelStatements(rawForParse);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: rawForParse }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				const lines = stmtText.split('\n');
				let runningOffset = baseOffset;
				let sawPipe = false;
				let allowIndentedContinuation = false;
				let expectPipeAfterBareId = false;
				for (const line of lines) {
					const trimmed = line.trim();
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

			const letNames = new Set<string>();
			try {
				for (const m of rawForParse.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
					if (m?.[2]) letNames.add(String(m[2]).toLowerCase());
				}
			} catch {
				// ignore
			}

			type StringRange = { start: number; end: number };
			const stringRanges: StringRange[] = [];
			try {
				let quote: '"' | '\'' | null = null;
				let start = -1;
				for (let i = 0; i < rawForParse.length; i++) {
					const ch = rawForParse[i];
					if (quote) {
						if (ch === '\\') {
							i++;
							continue;
						}
						if (ch === quote) {
							stringRanges.push({ start, end: i + 1 });
							quote = null;
							start = -1;
							continue;
						}
						continue;
					}
					if (ch === '"' || ch === "'") {
						quote = ch as '"' | '\'';
						start = i;
					}
				}
			} catch {
				// ignore
			}
			let stringRangeIdx = 0;
			const isInStringLiteral = (absoluteOffset: number) => {
				while (stringRangeIdx < stringRanges.length && stringRanges[stringRangeIdx].end <= absoluteOffset) {
					stringRangeIdx++;
				}
				const r = stringRanges[stringRangeIdx];
				return !!r && r.start <= absoluteOffset && absoluteOffset < r.end;
			};

			const tokens = scanTokens(rawForParse);
			const commentRanges = buildCommentRanges(rawForParse);

			// Column validation must be statement-scoped in multi-statement scripts (semicolon OR blank-line separated).
			// Otherwise, a `| project ...` in statement #1 could shrink the column set and make statement #2
			// incorrectly report unknown columns.
			const statements = (() => {
				try {
					const s = splitTopLevelStatements(raw);
					return s.length ? s : [{ startOffset: 0, text: raw }];
				} catch {
					return [{ startOffset: 0, text: raw }];
				}
			})();

			const kw = new Set([
				'let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata',
				'where', 'project', 'extend', 'summarize', 'order', 'sort', 'by', 'take', 'top', 'distinct', 'join', 'from', 'on', 'kind', 'as',
				'asc', 'desc',
				'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith', 'between', 'matches', 'true', 'false', 'null', 'case', 'then', 'else'
			]);
			const fnNames = KNOWN_FUNCTION_NAMES;

			for (const st of statements) {
				const stmtText = String(st?.text ?? '');
				if (!stmtText.trim()) continue;
				if (isDotCommandStatement(stmtText)) continue;
				const baseOffset = Number(st?.startOffset ?? 0) || 0;

				let activeTable: string | null = null;
				try {
					const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
					const lines = stmtText.split('\n');
					for (const line of lines) {
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
						const resolvedLet = resolveTabularLetToTable(name.toLowerCase());
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
						const letExprByNameLower = (() => {
							const map = new Map<string, string>();
							try {
								const stmts = splitTopLevelStatements(rawForParse);
								for (const st2 of (stmts.length ? stmts : [{ startOffset: 0, text: rawForParse }])) {
									const txt = String(st2?.text ?? '');
									const mLet = txt.match(/^\s*;*\s*let\s+([A-Za-z_][\w-]*)\s*=\s*/i);
									if (!mLet?.[1]) continue;
									const nameLower = String(mLet[1]).toLowerCase();
									const rhs = txt.slice(mLet[0].length).trim();
									if (!rhs) continue;
									// Skip scalar function-like lets (datetime(...), toscalar(...), etc.).
									const mFirst = rhs.match(/^([A-Za-z_][\w-]*)\b/);
									if (mFirst?.[1]) {
										const after = rhs.slice(mFirst[0].length);
										if (/^\s*\(/.test(after)) continue;
									}
									map.set(nameLower, rhs);
								}
							} catch {
								// ignore
							}
							return map;
						})();

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
						if (commentRanges.length && isInRanges(commentRanges, absoluteOffset)) continue;
						if (isInStringLiteral(absoluteOffset)) continue;
						if (letNames.has(nl)) continue;
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
