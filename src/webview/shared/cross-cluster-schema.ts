import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';

export interface CrossClusterSchemaContext {
	clusterUrl?: string | null;
	database?: string | null;
}

export interface CrossClusterSchemaRef {
	clusterName: string | null;
	database: string;
}

function normalizeClusterHost(value: string | null | undefined): string {
	return kustoClusterKey(value);
}

function clusterShortName(value: string | null | undefined): string {
	const host = normalizeClusterHost(value);
	return host ? (host.match(/^([^.]+)/)?.[1] || host) : '';
}

function addUniqueRef(refs: CrossClusterSchemaRef[], ref: CrossClusterSchemaRef): void {
	const clusterKey = ref.clusterName === null ? null : ref.clusterName.toLowerCase();
	const databaseKey = ref.database.toLowerCase();
	if (refs.some(candidate =>
		(candidate.clusterName === null ? null : candidate.clusterName.toLowerCase()) === clusterKey &&
		candidate.database.toLowerCase() === databaseKey
	)) {
		return;
	}
	refs.push(ref);
}

function getIgnoredTextRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '/' && next === '/') {
			const start = i;
			i += 2;
			while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
			ranges.push([start, i]);
			continue;
		}
		if (ch === '/' && next === '*') {
			const start = i;
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i = Math.min(text.length, i + 2);
			ranges.push([start, i]);
			continue;
		}
		if (ch === '`' && next === '`' && text[i + 2] === '`') {
			const start = i;
			i += 3;
			while (i < text.length && !(text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`')) i++;
			i = Math.min(text.length, i + 3);
			ranges.push([start, i]);
			continue;
		}
		if (ch === "'") {
			const start = i;
			i++;
			while (i < text.length) {
				if (text[i] === "'") {
					if (text[i + 1] === "'") {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			ranges.push([start, i]);
			continue;
		}
		if (ch === '"') {
			const start = i;
			i++;
			while (i < text.length) {
				if (text[i] === '\\') {
					i += 2;
					continue;
				}
				if (text[i] === '"') {
					i++;
					break;
				}
				i++;
			}
			ranges.push([start, i]);
			continue;
		}
		i++;
	}
	return ranges;
}

function isIgnoredIndex(ranges: Array<[number, number]>, index: number): boolean {
	return ranges.some(([start, end]) => index >= start && index < end);
}

function previousMeaningfulIndex(text: string, ranges: Array<[number, number]>, index: number): number {
	let i = index - 1;
	while (i >= 0) {
		if (/\s/.test(text[i])) {
			i--;
			continue;
		}
		const ignoredRange = ranges.find(([start, end]) => i >= start && i < end);
		if (ignoredRange) {
			i = ignoredRange[0] - 1;
			continue;
		}
		return i;
	}
	return -1;
}

function parseFunctionArgument(text: string, openParenIndex: number): { value: string; endIndex: number } | null {
	let i = openParenIndex + 1;
	while (i < text.length && /\s/.test(text[i])) i++;
	if (i >= text.length) {
		return null;
	}
	const quote = text[i] === "'" || text[i] === '"' ? text[i] : '';
	let value = '';
	if (quote) {
		i++;
		while (i < text.length) {
			const ch = text[i];
			if (quote === "'" && ch === "'" && text[i + 1] === "'") {
				value += "'";
				i += 2;
				continue;
			}
			if (quote === '"' && ch === '\\' && i + 1 < text.length) {
				value += text[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) {
				i++;
				while (i < text.length && /\s/.test(text[i])) i++;
				if (text[i] !== ')') {
					return null;
				}
				return { value, endIndex: i + 1 };
			}
			value += ch;
			i++;
		}
		return null;
	}
	while (i < text.length && text[i] !== ')' && !/\s/.test(text[i])) {
		value += text[i];
		i++;
	}
	while (i < text.length && /\s/.test(text[i])) i++;
	if (!value || text[i] !== ')') {
		return null;
	}
	return { value, endIndex: i + 1 };
}

function readFunctionCallArgument(text: string, functionName: string, startIndex: number): { value: string; callStart: number; callEnd: number } | null {
	const callStart = Math.max(0, startIndex);
	let i = callStart;
	while (i < text.length && /\s/.test(text[i])) i++;
	if (text.slice(i, i + functionName.length).toLowerCase() !== functionName.toLowerCase()) {
		return null;
	}
	const before = i > 0 ? text[i - 1] : '';
	const afterNameIndex = i + functionName.length;
	const afterName = text[afterNameIndex] || '';
	if ((before && /[A-Za-z0-9_]/.test(before)) || (afterName && /[A-Za-z0-9_]/.test(afterName))) {
		return null;
	}
	let openParenIndex = afterNameIndex;
	while (openParenIndex < text.length && /\s/.test(text[openParenIndex])) openParenIndex++;
	if (text[openParenIndex] !== '(') {
		return null;
	}
	const parsed = parseFunctionArgument(text, openParenIndex);
	if (!parsed) {
		return null;
	}
	return { value: parsed.value, callStart: i, callEnd: parsed.endIndex };
}

export function extractCrossClusterRefs(queryText: unknown, currentContext?: CrossClusterSchemaContext | null): CrossClusterSchemaRef[] {
	const refs: CrossClusterSchemaRef[] = [];
	if (typeof queryText !== 'string' || !queryText) {
		return refs;
	}

	const currentClusterShort = clusterShortName(currentContext?.clusterUrl);
	const currentClusterHost = normalizeClusterHost(currentContext?.clusterUrl);
	const currentDbLower = String(currentContext?.database || '').toLowerCase();
	const clusterDbPattern = /\bcluster\s*\(/gi;
	const clusterDatabaseRanges: Array<[number, number]> = [];
	const ignoredTextRanges = getIgnoredTextRanges(queryText);
	let match: RegExpExecArray | null;

	while ((match = clusterDbPattern.exec(queryText)) !== null) {
		if (isIgnoredIndex(ignoredTextRanges, match.index)) {
			continue;
		}
		const clusterParsed = parseFunctionArgument(queryText, clusterDbPattern.lastIndex - 1);
		if (!clusterParsed) {
			continue;
		}
		let dotIndex = clusterParsed.endIndex;
		while (dotIndex < queryText.length && /\s/.test(queryText[dotIndex])) dotIndex++;
		if (queryText[dotIndex] !== '.') {
			continue;
		}
		const databaseCallStart = dotIndex + 1;
		let databaseNameStart = databaseCallStart;
		while (databaseNameStart < queryText.length && /\s/.test(queryText[databaseNameStart])) databaseNameStart++;
		if (isIgnoredIndex(ignoredTextRanges, databaseNameStart)) {
			continue;
		}
		const databaseParsed = readFunctionCallArgument(queryText, 'database', databaseCallStart);
		if (!databaseParsed) {
			continue;
		}
		clusterDatabaseRanges.push([match.index, databaseParsed.callEnd]);
		const clusterName = clusterParsed.value;
		const database = databaseParsed.value;
		if (!clusterName || !database) {
			continue;
		}

		const clusterLower = clusterName.toLowerCase();
		const clusterHostLower = normalizeClusterHost(clusterName);
		const databaseLower = database.toLowerCase();
		if (currentDbLower && databaseLower === currentDbLower) {
			if (currentClusterShort && (clusterLower === currentClusterShort || clusterHostLower === currentClusterShort)) {
				continue;
			}
			if (currentClusterHost && (clusterLower === currentClusterHost || clusterHostLower === currentClusterHost)) {
				continue;
			}
		}

		addUniqueRef(refs, { clusterName, database });
	}

	const dbOnlyPattern = /\bdatabase\s*\(/gi;
	while ((match = dbOnlyPattern.exec(queryText)) !== null) {
		if (isIgnoredIndex(ignoredTextRanges, match.index)) {
			continue;
		}
		const previousIndex = previousMeaningfulIndex(queryText, ignoredTextRanges, match.index);
		if (previousIndex >= 0 && queryText[previousIndex] === '.') {
			continue;
		}
		if (clusterDatabaseRanges.some(([start, end]) => match!.index >= start && match!.index < end)) {
			continue;
		}
		const databaseParsed = parseFunctionArgument(queryText, dbOnlyPattern.lastIndex - 1);
		if (!databaseParsed) {
			continue;
		}
		const database = databaseParsed.value;
		if (!database || database.toLowerCase() === currentDbLower) {
			continue;
		}
		addUniqueRef(refs, { clusterName: null, database });
	}

	return refs;
}

export function getCrossClusterSchemaCheckDelay(now: number, lastInteractionAt: number, minIdleMs: number): number {
	const minIdle = Math.max(0, Number(minIdleMs) || 0);
	if (minIdle === 0) {
		return 0;
	}
	const lastInteraction = Math.max(0, Number(lastInteractionAt) || 0);
	if (lastInteraction === 0) {
		return 0;
	}
	const idleFor = Math.max(0, (Number(now) || 0) - lastInteraction);
	return idleFor >= minIdle ? 0 : minIdle - idleFor;
}