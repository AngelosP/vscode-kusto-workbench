import { analyzeKqlSource } from './kqlLanguageService/sourceAnalysis';
import type { DatabaseSchemaIndex } from './kustoClient';

export type KqlSchemaMatchTokens = {
	tableNamesLower: Set<string>;
	functionNamesLower: Set<string>;
	allNamesLower: Set<string>;
};

const normalizeNameLower = (name: string): string => String(name || '').trim().toLowerCase();

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
	const analysis = analyzeKqlSource(queryText);

	for (const reference of analysis.physicalTableReferences) {
		const nameLower = normalizeNameLower(reference.name);
		if (nameLower) tableNamesLower.add(nameLower);
	}

	// Functions remain a best-effort token scan over the canonical masked source.
	try {
		const re = /\b([A-Za-z_][\w-]*)\s*\(/g;
		for (const m of analysis.maskedText.matchAll(re)) {
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
