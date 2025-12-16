import { DatabaseSchemaIndex } from '../kustoClient';
import { KqlDiagnostic, KqlDiagnosticSeverity, type KqlPosition, type KqlRange, type KqlTableReference } from './protocol';

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
	const raw = String(text ?? '');
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
			if (ch === '\n') inLineComment = false;
			continue;
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
		if (!raw.trim()) {
			return diagnostics;
		}

		const lineStarts = buildLineStarts(raw);
		const tables = schema?.tables && Array.isArray(schema.tables) ? schema.tables : [];
		const columnsByTable = schema?.columnsByTable && typeof schema.columnsByTable === 'object' ? schema.columnsByTable : undefined;
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
			const statements = splitTopLevelStatements(raw);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
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

			const statements = splitTopLevelStatements(raw);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
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
			const statements = splitTopLevelStatements(raw);
			const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
			for (const st of stmts) {
				const stmtText = String(st?.text ?? '');
				const baseOffset = Number(st?.startOffset ?? 0) || 0;
				const lines = stmtText.split('\n');
				let runningOffset = baseOffset;
				let sawPipe = false;
				let allowIndentedContinuation = false;
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === ';') {
						sawPipe = false;
						allowIndentedContinuation = false;
						runningOffset += line.length + 1;
						continue;
					}
					if (trimmed.startsWith('//')) {
						runningOffset += line.length + 1;
						continue;
					}
					if (trimmed.startsWith('|')) {
						sawPipe = true;
						allowIndentedContinuation = /^\|\s*(where|filter|summarize|extend|project\b|project-rename\b|project-away\b|project-keep\b|project-reorder\b|project-smart\b)\b/i.test(trimmed);
						runningOffset += line.length + 1;
						continue;
					}
					if (sawPipe) {
						const isIndented = /^\s+/.test(line);
						if (allowIndentedContinuation && isIndented) {
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
				for (const m of raw.matchAll(/(^|\n)\s*let\s+([A-Za-z_][\w-]*)\s*=/gi)) {
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
				for (let i = 0; i < raw.length; i++) {
					const ch = raw[i];
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

			const tokens = scanTokens(raw);

			// Column validation must be statement-scoped in multi-statement scripts.
			// Otherwise, an operator clause (e.g. `| distinct ...`) could accidentally consume the next statement
			// (e.g. `;\nlet X = Table`) and treat table names as columns.
			const stmtRanges = (() => {
				try {
					const statements = splitTopLevelStatements(raw);
					const stmts = statements.length ? statements : [{ startOffset: 0, text: raw }];
					return stmts.map((s) => ({
						start: Number(s.startOffset ?? 0) || 0,
						end: (Number(s.startOffset ?? 0) || 0) + String(s.text ?? '').length
					}));
				} catch {
					return [{ start: 0, end: raw.length }];
				}
			})();
			const findStatementEndForOffset = (offset: number): number => {
				for (const r of stmtRanges) {
					if (r.start <= offset && offset < r.end) return r.end;
				}
				return raw.length;
			};

			let activeTable: string | null = null;
			try {
				const ignore = new Set(['let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata']);
				const lines = raw.split('\n');
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
			if (!activeTable) {
				activeTable = null;
			}

			let colSet: Set<string> | null = null;
			let dynamicRootCols = new Set<string>();
			if (activeTable) {
				colSet = new Set((columnsByTable[activeTable] || []).map((c) => String(c)));
				dynamicRootCols = getDynamicColumnsForTable(activeTable);
			}

			const kw = new Set([
				'let', 'set', 'declare', 'print', 'range', 'datatable', 'externaldata',
				'where', 'project', 'extend', 'summarize', 'order', 'sort', 'by', 'take', 'top', 'distinct', 'join', 'from', 'on', 'kind', 'as',
				'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith', 'between', 'matches', 'true', 'false', 'null', 'case', 'then', 'else'
			]);
			const fnNames = KNOWN_FUNCTION_NAMES;

			const currentColumns = () => (colSet ? Array.from(colSet) : []);

			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				if (!t || t.depth !== 0 || t.type !== 'pipe') continue;
				const statementEnd = findStatementEndForOffset(t.offset);

				let opTok: Extract<Token, { type: 'ident' }> | null = null;
				for (let j = i + 1; j < tokens.length; j++) {
					const tt = tokens[j];
					if (!tt || tt.depth !== 0) continue;
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
				let clauseEnd = raw.length;
				for (let j = i + 1; j < tokens.length; j++) {
					const tt = tokens[j];
					if (!tt || tt.depth !== 0) continue;
					if (tt.type === 'pipe' && tt.offset > opTok.offset) {
						clauseEnd = tt.offset;
						break;
					}
				}
				// Clamp the clause to the current statement boundary.
				clauseEnd = Math.min(clauseEnd, statementEnd);
				if (clauseStart >= clauseEnd) continue;
				const clauseText = raw.slice(clauseStart, clauseEnd);

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
						for (const tt of tokens) {
							if (!tt || tt.depth !== 0 || tt.type !== 'ident') continue;
							if (tt.offset < clauseStart || tt.offset >= clauseEnd) continue;
							if (String(tt.value ?? '').toLowerCase() === 'by') byTok = tt;
						}
						if (byTok) {
							const byText = raw.slice(byTok.endOffset, clauseEnd);
							for (const m of byText.matchAll(/\b([A-Za-z_][\w-]*)\b/g)) {
								const name = m[1];
								if (name && inputColSet && inputColSet.has(name)) next.add(name);
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

					// Allow `dynamicColumn.any.property.chain` when the root is a known dynamic column.
					try {
						const localIndex = typeof m.index === 'number' ? m.index : 0;
						const root = getDotChainRoot(clauseText, localIndex);
						if (root && validateSet && validateSet.has(root) && dynamicRootCols.has(root)) {
							continue;
						}
					} catch {
						// ignore
					}

					// Skip assignment LHS (X = ...)
					try {
						const afterLocal = clauseText.slice((typeof m.index === 'number' ? m.index : 0) + name.length);
						if (/^\s*=/.test(afterLocal)) continue;
					} catch {
						// ignore
					}

					const absoluteOffset = clauseStart + (typeof m.index === 'number' ? m.index : 0);
					if (isInStringLiteral(absoluteOffset)) continue;
					if (letNames.has(nl)) continue;
					try {
						const after = raw.slice(absoluteOffset + name.length, Math.min(raw.length, absoluteOffset + name.length + 6));
						if (/^\s*\(/.test(after)) continue;
					} catch {
						// ignore
					}

					if (validateSet && !validateSet.has(name)) {
						reportUnknown('KW_UNKNOWN_COLUMN', 'column', name, absoluteOffset, absoluteOffset + name.length, currentColumns());
					}
				}

				if (nextColSet) {
					colSet = nextColSet;
				}
			}
		}

		return diagnostics;
	}
}
