// Caret documentation & hover providers — extracted from monaco.ts
// KQL keyword/function docs, control command docs, hover resolution.
// Call initCaretDocsDeps(monaco) from the require callback to provide the AMD reference.
import { postMessageToHost } from '../shared/webview-messages';
import { __kustoGetStatementStartAtOffset } from './diagnostics';

// Generated functions merge flag (shared with monaco-completions.ts via re-export from monaco.ts)
export let __kustoGeneratedFunctionsMerged = false;
export function setGeneratedFunctionsMerged(v: boolean) { __kustoGeneratedFunctionsMerged = v; }

// Control command doc cache / pending fetch tracking — re-exported by monaco.ts.
export let __kustoControlCommandDocCache: Record<string, any> = {};
export let __kustoControlCommandDocPending: Record<string, any> = {};

// AMD reference — set via initCaretDocsDeps().
let _monacoRange: any = null;
let _monacoPosition: any = null;

const _win = window;

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

// Merge generated function docs (from `src/webview/generated/functions.generated.js`) into our in-memory
// `KUSTO_FUNCTION_DOCS` table. Smart Docs (hover/caret-docs panel) and autocomplete both rely on
// `KUSTO_FUNCTION_DOCS`, so this must run even if the user never triggers completion.
const __kustoEnsureGeneratedFunctionsMerged = () => {
	try {
		if (typeof window === 'undefined' || !window) return;
		if (__kustoGeneratedFunctionsMerged) return;
		__kustoGeneratedFunctionsMerged = true;

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
// Data is provided by `src/webview/generated/controlCommands.generated.js`.
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
		if (!__kustoControlCommandDocCache || typeof __kustoControlCommandDocCache !== 'object') {
			__kustoControlCommandDocCache = {};
		}
		if (!__kustoControlCommandDocPending || typeof __kustoControlCommandDocPending !== 'object') {
			__kustoControlCommandDocPending = {};
		}
		return __kustoControlCommandDocCache;
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
		if (__kustoControlCommandDocPending && __kustoControlCommandDocPending[key]) return;
		const requestId = `ccs_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
		__kustoControlCommandDocPending[key] = requestId;
		try {
			postMessageToHost({
				type: 'fetchControlCommandSyntax',
				requestId,
				commandLower: key,
				href: String(cmd.href)
			});
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
		const range = new _monacoRange(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
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
		const range = new _monacoRange(lineNumber, start + 1, lineNumber, end + 1);
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
					return { key: chk.key, range: new _monacoRange(lineNumber, startCol, lineNumber, endCol) };
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
		return new _monacoRange(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
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
			const range = new _monacoRange(lineNumber, opStartIdx + 1, lineNumber, opEndIdx + 1);
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
			const pipePos = new _monacoPosition(pipeLine, pipeIdx + 1);
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
			const range = new _monacoRange(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);

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
			const range = new _monacoRange(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
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

/** Inject the AMD-scoped monaco reference. Call once after require() resolves. */
export function initCaretDocsDeps(monacoRef: any) {
	_monacoRange = monacoRef ? monacoRef.Range : null;
	_monacoPosition = monacoRef ? monacoRef.Position : null;
}

// ── Public API ──
export { getHoverInfoAt, KUSTO_FUNCTION_DOCS, KUSTO_KEYWORD_DOCS };
export { findEnclosingFunctionCall, getTokenAtPosition, getMultiWordOperatorAt };
export { getWordRangeAt, computeArgIndex, buildFunctionSignatureMarkdown };
export { __kustoEnsureGeneratedFunctionsMerged };
export { KUSTO_CONTROL_COMMAND_DOCS_BASE_URL, KUSTO_CONTROL_COMMAND_DOCS_VIEW, __kustoControlCommands };
export { __kustoNormalizeControlCommand, __kustoBuildControlCommandIndex };
export { __kustoGetOrInitControlCommandDocCache, __kustoParseControlCommandSyntaxFromLearnHtml };
export { __kustoExtractWithOptionArgsFromSyntax, __kustoScheduleFetchControlCommandSyntax };
export { __kustoFindEnclosingWithOptionsParen, __kustoFindWithOptionsParenRange };
export { __kustoGetControlCommandHoverAt };

