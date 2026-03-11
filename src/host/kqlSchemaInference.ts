import { KqlLanguageService } from './kqlLanguageService/service';
import type { DatabaseSchemaIndex } from './kustoClient';

export type KqlSchemaMatchTokens = {
	tableNamesLower: Set<string>;
	functionNamesLower: Set<string>;
	allNamesLower: Set<string>;
};

const normalizeNameLower = (name: string): string => String(name || '').trim().toLowerCase();

const stripCommentsAndStringsBestEffort = (text: string): string => {
	// Best-effort masking so we can scan for "Foo(" without matching comments/strings.
	// Keep length/offsets irrelevant for our use-case.
	const s = String(text ?? '');
	let out = '';
	let inLine = false;
	let inBlock = false;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		const next = s[i + 1];
		if (inLine) {
			if (ch === '\n') {
				inLine = false;
				out += ch;
			} else {
				out += ' ';
			}
			continue;
		}
		if (inBlock) {
			if (ch === '*' && next === '/') {
				out += '  ';
				i++;
				inBlock = false;
				continue;
			}
			out += ch === '\n' ? ch : ' ';
			continue;
		}
		if (inSingle) {
			out += ' ';
			if (ch === "'") {
				// Kusto escape ''
				if (next === "'") {
					out += ' ';
					i++;
					continue;
				}
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			out += ' ';
			if (ch === '\\') {
				if (next !== undefined) {
					out += ' ';
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
			out += '  ';
			i++;
			inLine = true;
			continue;
		}
		if (ch === '/' && next === '*') {
			out += '  ';
			i++;
			inBlock = true;
			continue;
		}
		if (ch === "'") {
			out += ' ';
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			out += ' ';
			inDouble = true;
			continue;
		}

		out += ch;
	}
	return out;
};

const DEFAULT_FUNCTION_STOPLIST = new Set(
	[
		// Common KQL built-ins and query operators (not exhaustive, just de-noise).
		'where',
		'project',
		'extend',
		'summarize',
		'join',
		'lookup',
		'union',
		'take',
		'top',
		'limit',
		'count',
		'countif',
		'dcount',
		'sum',
		'avg',
		'min',
		'max',
		'ago',
		'now',
		'bin',
		'bin_at',
		'todatetime',
		'tostring',
		'tolower',
		'toupper',
		'parse_json',
		'coalesce',
		'iif',
		'iff',
		'case'
	].map((s) => s.toLowerCase())
);

export const extractKqlSchemaMatchTokens = (queryText: string): KqlSchemaMatchTokens => {
	const tableNamesLower = new Set<string>();
	const functionNamesLower = new Set<string>();

	// 1) Tables/views: use the existing lightweight KQL language service.
	try {
		const svc = new KqlLanguageService();
		const refs = svc.findTableReferences(String(queryText ?? ''));
		for (const r of refs) {
			const n = normalizeNameLower(r?.name || '');
			if (n) tableNamesLower.add(n);
		}
	} catch {
		// ignore
	}

	// 2) Functions: best-effort scan for Identifier(
	try {
		const masked = stripCommentsAndStringsBestEffort(String(queryText ?? ''));
		const re = /\b([A-Za-z_][\w-]*)\s*\(/g;
		for (const m of masked.matchAll(re)) {
			const raw = String(m?.[1] || '');
			const n = normalizeNameLower(raw);
			if (!n) continue;
			if (DEFAULT_FUNCTION_STOPLIST.has(n)) continue;
			functionNamesLower.add(n);
		}
	} catch {
		// ignore
	}

	const allNamesLower = new Set<string>([...tableNamesLower, ...functionNamesLower]);
	return { tableNamesLower, functionNamesLower, allNamesLower };
};

export const scoreSchemaMatch = (tokens: KqlSchemaMatchTokens, schema: DatabaseSchemaIndex | undefined | null): number => {
	if (!tokens || !schema) return 0;
	let score = 0;

	try {
		for (const t of schema.tables || []) {
			const n = normalizeNameLower(String(t || ''));
			if (n && tokens.tableNamesLower.has(n)) {
				// Tables/views are the strongest signal.
				score += 3;
			}
		}
	} catch {
		// ignore
	}

	try {
		const funcs = Array.isArray(schema.functions) ? schema.functions : [];
		for (const f of funcs) {
			const n = normalizeNameLower(String((f as any)?.name || ''));
			if (n && tokens.functionNamesLower.has(n)) {
				score += 1;
			}
		}
	} catch {
		// ignore
	}

	return score;
};
