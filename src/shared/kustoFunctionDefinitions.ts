export type KustoFunctionDefinition = {
	name: string;
	rawParams: string;
	body: string;
	start: number;
	end: number;
};

type ScanState = {
	inSingle: boolean;
	inDouble: boolean;
	inLineComment: boolean;
	inBlockComment: boolean;
	inTripleBacktick: boolean;
};

const createState = (): ScanState => ({
	inSingle: false,
	inDouble: false,
	inLineComment: false,
	inBlockComment: false,
	inTripleBacktick: false,
});

export function normalizeKustoText(input: unknown): string {
	return String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function stripSingleKustoCodeFence(input: string): string {
	const text = normalizeKustoText(input).trim();
	const match = /^```(?:kusto|kql)?\s*\n([\s\S]*?)\n```$/i.exec(text);
	return match ? String(match[1] ?? '').trim() : text;
}

export function getSingleKustoCodeFenceBodyRange(input: unknown): { start: number; end: number; text: string } | null {
	const text = normalizeKustoText(input);
	const match = /^\s*```(?:kusto|kql)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
	if (!match || match.index === undefined) return null;
	const body = String(match[1] ?? '');
	const bodyStart = match[0].indexOf(body);
	if (bodyStart < 0) return null;
	const start = match.index + bodyStart;
	return { start, end: start + body.length, text: body };
}

function updateScanState(text: string, index: number, state: ScanState): number {
	const ch = text[index];
	const next = index + 1 < text.length ? text[index + 1] : '';
	const next2 = index + 2 < text.length ? text[index + 2] : '';

	if (state.inLineComment) {
		if (ch === '\n') state.inLineComment = false;
		return index;
	}
	if (state.inBlockComment) {
		if (ch === '*' && next === '/') {
			state.inBlockComment = false;
			return index + 1;
		}
		return index;
	}
	if (state.inTripleBacktick) {
		if (ch === '`' && next === '`' && next2 === '`') {
			state.inTripleBacktick = false;
			return index + 2;
		}
		return index;
	}
	if (state.inSingle) {
		if (ch === "'") {
			if (next === "'") return index + 1;
			state.inSingle = false;
		}
		return index;
	}
	if (state.inDouble) {
		if (ch === '\\') return index + 1;
		if (ch === '"') state.inDouble = false;
		return index;
	}

	if (ch === '/' && next === '/') {
		state.inLineComment = true;
		return index + 1;
	}
	if (ch === '/' && next === '*') {
		state.inBlockComment = true;
		return index + 1;
	}
	if (ch === '`' && next === '`' && next2 === '`') {
		state.inTripleBacktick = true;
		return index + 2;
	}
	if (ch === "'") {
		state.inSingle = true;
		return index;
	}
	if (ch === '"') {
		state.inDouble = true;
		return index;
	}

	return index;
}

function isCodeState(state: ScanState): boolean {
	return !state.inSingle && !state.inDouble && !state.inLineComment && !state.inBlockComment && !state.inTripleBacktick;
}

function isBoundary(text: string, index: number): boolean {
	if (index <= 0) return true;
	const prev = text[index - 1];
	return /[\s;]/.test(prev ?? '');
}

function commandAt(text: string, start: number): RegExpExecArray | null {
	const slice = text.slice(start);
	return /^\.(create-or-alter|create|alter)\s+function\b/i.exec(slice);
}

function findMatching(text: string, openIndex: number, openChar: string, closeChar: string): number {
	let depth = 1;
	const state = createState();
	for (let index = openIndex + 1; index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		const ch = text[index];
		if (ch === openChar) depth++;
		else if (ch === closeChar) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function findTopLevelChar(text: string, wanted: string): number {
	const state = createState();
	for (let index = 0; index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		if (text[index] === wanted) return index;
	}
	return -1;
}

function findTopLevelKeywordLocal(text: string, keyword: string): number {
	const lower = text.toLowerCase();
	const wanted = keyword.toLowerCase();
	const state = createState();
	for (let index = 0; index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		if (!lower.startsWith(wanted, index)) continue;
		const before = index === 0 ? '' : lower[index - 1];
		const after = lower[index + wanted.length] ?? '';
		if ((!before || /[^a-z0-9_]/i.test(before)) && (!after || /[^a-z0-9_]/i.test(after))) {
			return index;
		}
	}
	return -1;
}

function parseDefinitionAt(text: string, start: number): KustoFunctionDefinition | null {
	const cmdMatch = commandAt(text, start);
	if (!cmdMatch) return null;
	let cursor = start + cmdMatch[0].length;
	const commandKind = cmdMatch[1].toLowerCase();
	let rest = text.slice(cursor);

	if (commandKind === 'alter' && /^\s*(docstring|folder)\b/i.test(rest)) return null;

	const ifNotExists = /^\s+ifnotexists\b/i.exec(rest);
	if (ifNotExists) {
		cursor += ifNotExists[0].length;
		rest = text.slice(cursor);
	}

	let signatureSearchStart = 0;
	const withPrefix = /^\s*with\b/i.exec(rest);
	if (withPrefix) {
		let withOpen = withPrefix[0].length;
		while (withOpen < rest.length && /\s/.test(rest[withOpen] ?? '')) withOpen++;
		if (rest[withOpen] !== '(') return null;
		const withClose = findMatching(rest, withOpen, '(', ')');
		if (withClose < 0) return null;
		signatureSearchStart = withClose + 1;
	}

	const relativeOpenParen = findTopLevelChar(rest.slice(signatureSearchStart), '(');
	let openParenInRest = relativeOpenParen < 0 ? -1 : signatureSearchStart + relativeOpenParen;
	if (openParenInRest < 0) return null;

	const closeParen = findMatching(rest, openParenInRest, '(', ')');
	if (closeParen < 0) return null;

	const namePrefix = rest.slice(signatureSearchStart, openParenInRest).trim();
	const name = namePrefix.split(/\s+/).pop()?.trim() ?? '';
	if (!name) return null;

	const signatureEnd = cursor + closeParen + 1;
	let braceIndex = signatureEnd;
	while (braceIndex < text.length && /\s/.test(text[braceIndex] ?? '')) braceIndex++;
	if (text[braceIndex] !== '{') return null;
	const bodyEnd = findMatching(text, braceIndex, '{', '}');
	if (bodyEnd < 0) return null;

	return {
		name,
		rawParams: rest.slice(openParenInRest + 1, closeParen),
		body: text.slice(braceIndex + 1, bodyEnd),
		start,
		end: bodyEnd + 1,
	};
}

export function findFirstKustoFunctionDefinition(input: unknown): KustoFunctionDefinition | null {
	const text = stripSingleKustoCodeFence(normalizeKustoText(input));
	const state = createState();
	for (let index = 0; index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		if (text[index] !== '.' || !isBoundary(text, index)) continue;
		const parsed = parseDefinitionAt(text, index);
		if (parsed) return parsed;
	}
	return null;
}

export function hasKustoFunctionDefinition(input: unknown): boolean {
	return !!findFirstKustoFunctionDefinition(input);
}

export function findKustoFunctionDefinitionAtOffset(input: unknown, offsetRaw: number): KustoFunctionDefinition | null {
	const text = normalizeKustoText(input);
	const offset = Math.max(0, Number(offsetRaw) || 0);
	const state = createState();
	for (let index = 0; index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		if (text[index] !== '.' || !isBoundary(text, index)) continue;
		const parsed = parseDefinitionAt(text, index);
		if (!parsed) continue;
		if (offset >= parsed.start && offset <= parsed.end) return parsed;
		index = Math.max(index, parsed.end - 1);
	}
	return null;
}

function findNextFunctionDefinition(text: string, start: number): KustoFunctionDefinition | null {
	const state = createState();
	for (let index = Math.max(0, start); index < text.length; index++) {
		index = updateScanState(text, index, state);
		if (!isCodeState(state)) continue;
		if (text[index] !== '.' || !isBoundary(text, index)) continue;
		const parsed = parseDefinitionAt(text, index);
		if (parsed) return parsed;
	}
	return null;
}

function consumeOptionalSemicolon(text: string, index: number): number {
	let cursor = index;
	while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor++;
	if (text[cursor] === ';') cursor++;
	return cursor;
}

function hasRunnableQueryTail(text: string): boolean {
	const state = createState();
	for (let index = 0; index < text.length; index++) {
		const wasCode = isCodeState(state);
		index = updateScanState(text, index, state);
		if (!wasCode || !isCodeState(state)) continue;
		const ch = text[index] ?? '';
		if (/\s|;/.test(ch)) continue;
		return ch !== '.';
	}
	return false;
}

export function inlineLetForDefinition(definition: Pick<KustoFunctionDefinition, 'name' | 'rawParams' | 'body'>): string {
	return `let ${definition.name} = (${definition.rawParams}) {${definition.body}};`;
}

export function convertKustoFunctionDefinitionsToInline(input: unknown): string | null {
	const text = stripSingleKustoCodeFence(normalizeKustoText(input));
	if (!text.trim()) return null;
	let cursor = 0;
	let converted = '';
	let didConvert = false;
	while (cursor < text.length) {
		const definition = findNextFunctionDefinition(text, cursor);
		if (!definition) break;
		converted += text.slice(cursor, definition.start) + inlineLetForDefinition(definition);
		didConvert = true;
		cursor = consumeOptionalSemicolon(text, definition.end);
	}
	if (!didConvert) return null;
	const tail = text.slice(cursor);
	if (!hasRunnableQueryTail(tail)) return null;
	converted += tail;
	return converted.trim();
}