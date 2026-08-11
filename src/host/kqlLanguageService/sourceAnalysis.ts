export type KqlSourceRange = Readonly<{
	startOffset: number;
	endOffset: number;
}>;

export type KqlSourceStatement = Readonly<{
	startOffset: number;
	endOffset: number;
	text: string;
	maskedText: string;
}>;

export type KqlSourceReference = Readonly<{
	name: string;
	nameLower: string;
	startOffset: number;
	endOffset: number;
}>;

export type KqlLetBinding = Readonly<{
	name: string;
	nameLower: string;
	startOffset: number;
	endOffset: number;
	rhsStartOffset: number;
	rhsEndOffset: number;
	scopeStartOffset: number;
	scopeEndOffset: number;
	rhsText: string;
	maskedRhsText: string;
	kind: 'scalar' | 'tabular' | 'function';
	source?: KqlSourceReference;
	bodyRange?: KqlSourceRange;
}>;

export type KqlTabularScope = Readonly<{
	kind: 'let' | 'parameters';
	startOffset: number;
	endOffset: number;
	namesLower: readonly string[];
}>;

export type KqlParameterScope = Readonly<{
	kind: 'scalar' | 'tabular' | 'query';
	startOffset: number;
	endOffset: number;
	namesLower: readonly string[];
}>;

export type KqlSourceAnalysis = Readonly<{
	text: string;
	maskedText: string;
	commentRanges: readonly KqlSourceRange[];
	stringRanges: readonly KqlSourceRange[];
	statements: readonly KqlSourceStatement[];
	letBindings: readonly KqlLetBinding[];
	tabularScopes: readonly KqlTabularScope[];
	parameterScopes: readonly KqlParameterScope[];
	physicalTableReferences: readonly KqlSourceReference[];
}>;

const IGNORED_SOURCE_NAMES = new Set([
	'let',
	'set',
	'declare',
	'print',
	'range',
	'datatable',
	'externaldata',
	'evaluate',
	'false',
	'find',
	'null',
	'search',
	'true',
	'union'
]);

const TABULAR_CONSTRUCTORS = new Set([
	'datatable',
	'evaluate',
	'externaldata',
	'find',
	'print',
	'range',
	'search',
	'table',
	'union'
]);

const TABULAR_WRAPPERS = new Set(['materialize']);
const SCALAR_QUERY_WRAPPERS = new Set(['toscalar']);

const freezeRange = (startOffset: number, endOffset: number): KqlSourceRange =>
	Object.freeze({ startOffset, endOffset });

const maskCharacter = (characters: string[], source: string, offset: number): void => {
	const character = source[offset];
	characters[offset] = character === '\r' || character === '\n' ? character : ' ';
};

const detectStringPrefix = (source: string, offset: number): {
	quote: '"' | "'";
	length: number;
	verbatim: boolean;
} | undefined => {
	const character = source[offset];
	const next = source[offset + 1];
	const third = source[offset + 2];
	const previous = source[offset - 1];
	const isQuote = (value: string | undefined): value is '"' | "'" => value === '"' || value === "'";
	const hasIdentifierPrefix = previous !== undefined && /[A-Za-z0-9_-]/.test(previous);

	if (character === '@' && isQuote(next)) {
		return { quote: next, length: 2, verbatim: true };
	}
	if (!hasIdentifierPrefix && (character === 'h' || character === 'H')) {
		if (next === '@' && isQuote(third)) {
			return { quote: third, length: 3, verbatim: true };
		}
		if (isQuote(next)) {
			return { quote: next, length: 2, verbatim: false };
		}
	}
	if (isQuote(character)) {
		return { quote: character, length: 1, verbatim: false };
	}
	return undefined;
};


const maskSource = (source: string): {
	maskedText: string;
	commentRanges: readonly KqlSourceRange[];
	stringRanges: readonly KqlSourceRange[];
} => {
	const characters = source.split('');
	const commentRanges: KqlSourceRange[] = [];
	const stringRanges: KqlSourceRange[] = [];
	let offset = 0;

	while (offset < source.length) {
		const character = source[offset];
		const next = source[offset + 1];

		if (character === '/' && next === '/') {
			const startOffset = offset;
			while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') {
				maskCharacter(characters, source, offset);
				offset++;
			}
			commentRanges.push(freezeRange(startOffset, offset));
			continue;
		}

		if (character === '/' && next === '*') {
			const startOffset = offset;
			while (offset < source.length) {
				const closesComment = source[offset] === '*' && source[offset + 1] === '/';
				maskCharacter(characters, source, offset);
				offset++;
				if (closesComment && offset < source.length) {
					maskCharacter(characters, source, offset);
					offset++;
					break;
				}
			}
			commentRanges.push(freezeRange(startOffset, offset));
			continue;
		}

		if (character === '`' && next === '`' && source[offset + 2] === '`') {
			const startOffset = offset;
			for (let index = 0; index < 3; index++) {
				maskCharacter(characters, source, offset);
				offset++;
			}
			while (offset < source.length) {
				const closesString = source[offset] === '`' && source[offset + 1] === '`' && source[offset + 2] === '`';
				maskCharacter(characters, source, offset);
				offset++;
				if (closesString) {
					for (let index = 1; index < 3 && offset < source.length; index++) {
						maskCharacter(characters, source, offset);
						offset++;
					}
					break;
				}
			}
			stringRanges.push(freezeRange(startOffset, offset));
			continue;
		}

		const stringPrefix = detectStringPrefix(source, offset);
		if (stringPrefix) {
			const startOffset = offset;
			for (let index = 0; index < stringPrefix.length; index++) {
				maskCharacter(characters, source, offset);
				offset++;
			}
			while (offset < source.length) {
				const current = source[offset];
				const following = source[offset + 1];
				maskCharacter(characters, source, offset);
				offset++;
				if (current === stringPrefix.quote && following === stringPrefix.quote) {
					maskCharacter(characters, source, offset);
					offset++;
					continue;
				}
				if (!stringPrefix.verbatim && current === '\\' && offset < source.length) {
					maskCharacter(characters, source, offset);
					offset++;
					continue;
				}
				if (current === stringPrefix.quote) {
					break;
				}
			}
			stringRanges.push(freezeRange(startOffset, offset));
			continue;
		}

		offset++;
	}

	return {
		maskedText: characters.join(''),
		commentRanges: Object.freeze(commentRanges),
		stringRanges: Object.freeze(stringRanges)
	};
};

const isOffsetInRanges = (ranges: readonly KqlSourceRange[], offset: number): boolean => {
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const range = ranges[middle];
		if (offset < range.startOffset) {
			high = middle - 1;
		} else if (offset >= range.endOffset) {
			low = middle + 1;
		} else {
			return true;
		}
	}
	return false;
};

const splitStatements = (
	source: string,
	maskedText: string,
	protectedRanges: readonly KqlSourceRange[]
): readonly KqlSourceStatement[] => {
	const statements: KqlSourceStatement[] = [];
	let startOffset = 0;
	let depth = 0;

	const addStatement = (endOffset: number): void => {
		const text = source.slice(startOffset, endOffset);
		if (!text.trim()) {
			return;
		}
		statements.push(Object.freeze({
			startOffset,
			endOffset,
			text,
			maskedText: maskedText.slice(startOffset, endOffset)
		}));
	};

	for (let offset = 0; offset < maskedText.length; offset++) {
		const character = maskedText[offset];
		if (character === '(' || character === '[' || character === '{') {
			depth++;
			continue;
		}
		if (character === ')' || character === ']' || character === '}') {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (character === ';' && depth === 0) {
			addStatement(offset);
			startOffset = offset + 1;
			continue;
		}
		if (character !== '\n' || depth !== 0 || isOffsetInRanges(protectedRanges, offset)) {
			continue;
		}

		let nextLineOffset = offset + 1;
		while (
			nextLineOffset < source.length &&
			(source[nextLineOffset] === ' ' || source[nextLineOffset] === '\t' || source[nextLineOffset] === '\r')
		) {
			nextLineOffset++;
		}
		if (source[nextLineOffset] !== '\n') {
			continue;
		}

		addStatement(offset);
		startOffset = nextLineOffset + 1;
		while (startOffset < source.length) {
			const newlineOffset = source.indexOf('\n', startOffset);
			const lineEndOffset = newlineOffset < 0 ? source.length : newlineOffset;
			if (!/^[ \t\r]*$/.test(source.slice(startOffset, lineEndOffset))) {
				break;
			}
			startOffset = newlineOffset < 0 ? source.length : newlineOffset + 1;
		}
		offset = startOffset - 1;
	}

	addStatement(source.length);
	return Object.freeze(statements);
};

const skipWhitespace = (text: string, initialOffset: number, endOffset: number): number => {
	let offset = initialOffset;
	while (offset < endOffset && /\s/.test(text[offset])) {
		offset++;
	}
	return offset;
};

const readIdentifier = (text: string, initialOffset: number, endOffset: number): KqlSourceReference | undefined => {
	const startOffset = skipWhitespace(text, initialOffset, endOffset);
	if (startOffset >= endOffset || !/[A-Za-z_]/.test(text[startOffset])) {
		return undefined;
	}
	let offset = startOffset + 1;
	while (offset < endOffset && /[A-Za-z0-9_-]/.test(text[offset])) {
		offset++;
	}
	const name = text.slice(startOffset, offset);
	return Object.freeze({ name, nameLower: name.toLowerCase(), startOffset, endOffset: offset });
};

const readSourceReference = (text: string, initialOffset: number, endOffset: number): KqlSourceReference | undefined => {
	let offset = skipWhitespace(text, initialOffset, endOffset);
	while (text[offset] === '(') {
		offset = skipWhitespace(text, offset + 1, endOffset);
	}
	const reference = readIdentifier(text, offset, endOffset);
	if (!reference || IGNORED_SOURCE_NAMES.has(reference.nameLower)) {
		return undefined;
	}
	const afterReference = skipWhitespace(text, reference.endOffset, endOffset);
	if (
		text[afterReference] === '(' ||
		text[afterReference] === '*' ||
		(reference.startOffset > 0 && text[reference.startOffset - 1] === '.')
	) {
		return undefined;
	}
	return reference;
};

const findMatchingDelimiter = (
	text: string,
	openOffset: number,
	openCharacter: string,
	closeCharacter: string,
	endOffset: number
): number => {
	let depth = 0;
	for (let offset = openOffset; offset < endOffset; offset++) {
		if (text[offset] === openCharacter) {
			depth++;
		} else if (text[offset] === closeCharacter) {
			depth--;
			if (depth === 0) {
				return offset;
			}
		}
	}
	return -1;
};

const buildBraceRanges = (text: string): readonly KqlSourceRange[] => {
	const stack: number[] = [];
	const ranges: KqlSourceRange[] = [];
	for (let offset = 0; offset < text.length; offset++) {
		if (text[offset] === '{') {
			stack.push(offset);
		} else if (text[offset] === '}') {
			const startOffset = stack.pop();
			if (startOffset !== undefined) {
				ranges.push(freezeRange(startOffset, offset));
			}
		}
	}
	ranges.sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset);
	return Object.freeze(ranges);
};

const findBindingEnd = (
	text: string,
	rhsStartOffset: number,
	limitOffset: number
): { rhsEndOffset: number; scopeStartOffset: number } => {
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	for (let offset = rhsStartOffset; offset < limitOffset; offset++) {
		const character = text[offset];
		if (character === '(') parenDepth++;
		else if (character === ')' && parenDepth > 0) parenDepth--;
		else if (character === '[') bracketDepth++;
		else if (character === ']' && bracketDepth > 0) bracketDepth--;
		else if (character === '{') braceDepth++;
		else if (character === '}') {
			if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
				return { rhsEndOffset: offset, scopeStartOffset: offset };
			}
			if (braceDepth > 0) braceDepth--;
		} else if (character === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			return { rhsEndOffset: offset, scopeStartOffset: offset + 1 };
		}
	}
	return { rhsEndOffset: limitOffset, scopeStartOffset: limitOffset };
};

const readPhysicalSourceReference = (
	text: string,
	initialOffset: number,
	endOffset: number
): KqlSourceReference | undefined => {
	let offset = skipWhitespace(text, initialOffset, endOffset);
	while (text[offset] === '(') {
		offset = skipWhitespace(text, offset + 1, endOffset);
	}
	const directReference = readSourceReference(text, offset, endOffset);
	if (directReference) {
		return directReference;
	}
	const wrapper = readIdentifier(text, offset, endOffset);
	if (!wrapper || !TABULAR_WRAPPERS.has(wrapper.nameLower)) {
		return undefined;
	}
	const openParenOffset = skipWhitespace(text, wrapper.endOffset, endOffset);
	if (text[openParenOffset] !== '(') {
		return undefined;
	}
	const closeParenOffset = findMatchingDelimiter(text, openParenOffset, '(', ')', endOffset);
	const argumentEndOffset = closeParenOffset < 0 ? endOffset : closeParenOffset;
	const argumentStartOffset = skipWhitespace(text, openParenOffset + 1, argumentEndOffset);
	return readPhysicalSourceReference(text, argumentStartOffset, argumentEndOffset);
};

const readScalarQuerySourceReference = (
	text: string,
	initialOffset: number,
	endOffset: number
): KqlSourceReference | undefined => {
	let offset = skipWhitespace(text, initialOffset, endOffset);
	while (text[offset] === '(') offset = skipWhitespace(text, offset + 1, endOffset);
	const wrapper = readIdentifier(text, offset, endOffset);
	if (!wrapper || !SCALAR_QUERY_WRAPPERS.has(wrapper.nameLower)) return undefined;
	const openParenOffset = skipWhitespace(text, wrapper.endOffset, endOffset);
	if (text[openParenOffset] !== '(') return undefined;
	const closeParenOffset = findMatchingDelimiter(text, openParenOffset, '(', ')', endOffset);
	const argumentEndOffset = closeParenOffset < 0 ? endOffset : closeParenOffset;
	const argumentStartOffset = skipWhitespace(text, openParenOffset + 1, argumentEndOffset);
	return readPhysicalSourceReference(text, argumentStartOffset, argumentEndOffset)
		?? readScalarQuerySourceReference(text, argumentStartOffset, argumentEndOffset);
};

const isQualifiedTabularExpression = (text: string, startOffset: number, endOffset: number): boolean => {
	const expression = text.slice(startOffset, endOffset);
	return /^\s*(?:cluster\s*\([^)]*\)\s*\.\s*)?database\s*\([^)]*\)\s*\.\s*[A-Za-z_][\w-]*/i.test(expression)
		|| /^\s*cluster\s*\([^)]*\)\s*\.\s*database\s*\([^)]*\)\s*\.\s*[A-Za-z_][\w-]*/i.test(expression);
};

const splitTopLevelRanges = (text: string, startOffset: number, endOffset: number): readonly KqlSourceRange[] => {
	const ranges: KqlSourceRange[] = [];
	let segmentStartOffset = startOffset;
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	for (let offset = startOffset; offset < endOffset; offset++) {
		const character = text[offset];
		if (character === '(') parenDepth++;
		else if (character === ')' && parenDepth > 0) parenDepth--;
		else if (character === '[') bracketDepth++;
		else if (character === ']' && bracketDepth > 0) bracketDepth--;
		else if (character === '{') braceDepth++;
		else if (character === '}' && braceDepth > 0) braceDepth--;
		else if (character === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			ranges.push(freezeRange(segmentStartOffset, offset));
			segmentStartOffset = offset + 1;
		}
	}
	ranges.push(freezeRange(segmentStartOffset, endOffset));
	return Object.freeze(ranges);
};

const parseQueryParameterScopes = (maskedText: string): readonly KqlParameterScope[] => {
	const scopes: KqlParameterScope[] = [];
	for (const match of maskedText.matchAll(/\bdeclare\s+query_parameters\s*\(/gi)) {
		if (typeof match.index !== 'number') continue;
		const openParenOffset = maskedText.indexOf('(', match.index);
		if (openParenOffset < 0) continue;
		const closeParenOffset = findMatchingDelimiter(maskedText, openParenOffset, '(', ')', maskedText.length);
		if (closeParenOffset < 0) continue;
		const namesLower = splitTopLevelRanges(maskedText, openParenOffset + 1, closeParenOffset)
			.map((range) => maskedText.slice(range.startOffset, range.endOffset).match(/^\s*([A-Za-z_][\w-]*)\s*:/)?.[1])
			.filter((name): name is string => !!name)
			.map((name) => name.toLowerCase());
		if (!namesLower.length) continue;
		scopes.push(Object.freeze({
			kind: 'query',
			startOffset: 0,
			endOffset: maskedText.length,
			namesLower: Object.freeze(namesLower)
		}));
	}
	return Object.freeze(scopes);
};

const parseLetBindings = (
	source: string,
	maskedText: string,
	_statements: readonly KqlSourceStatement[]
): { bindings: readonly KqlLetBinding[]; parameterScopes: readonly KqlParameterScope[] } => {
	const bindings: KqlLetBinding[] = [];
	const parameterScopes: KqlParameterScope[] = [...parseQueryParameterScopes(maskedText)];
	const braceRanges = buildBraceRanges(maskedText);
	const bindingPattern = /\blet\s+([A-Za-z_][\w-]*)\s*=\s*/gi;

	for (const match of maskedText.matchAll(bindingPattern)) {
		if (!match[1] || typeof match.index !== 'number') continue;
		const name = match[1];
		const nameLocalOffset = match[0].toLowerCase().lastIndexOf(name.toLowerCase());
		const nameStartOffset = match.index + Math.max(0, nameLocalOffset);
		const rhsStartOffset = match.index + match[0].length;
		const enclosingBrace = braceRanges
			.filter((range) => range.startOffset < match.index && match.index < range.endOffset)
			.sort((left, right) => right.startOffset - left.startOffset)[0];
		const scopeEndOffset = enclosingBrace?.endOffset ?? maskedText.length;
		const bindingEnd = findBindingEnd(maskedText, rhsStartOffset, scopeEndOffset);
		const rhsEndOffset = bindingEnd.rhsEndOffset;
		const firstRhsOffset = skipWhitespace(maskedText, rhsStartOffset, rhsEndOffset);
		let kind: KqlLetBinding['kind'] = 'scalar';
		let sourceReference: KqlSourceReference | undefined;
		let bodyRange: KqlSourceRange | undefined;

		let functionOpenOffset = firstRhsOffset;
		const firstIdentifier = readIdentifier(maskedText, firstRhsOffset, rhsEndOffset);
		if (firstIdentifier?.nameLower === 'view') {
			functionOpenOffset = skipWhitespace(maskedText, firstIdentifier.endOffset, rhsEndOffset);
		}
		if (maskedText[functionOpenOffset] === '(') {
			const closeParenOffset = findMatchingDelimiter(maskedText, functionOpenOffset, '(', ')', rhsEndOffset);
			const bodyOpenOffset = closeParenOffset < 0
				? -1
				: skipWhitespace(maskedText, closeParenOffset + 1, rhsEndOffset);
			if (bodyOpenOffset >= 0 && maskedText[bodyOpenOffset] === '{') {
				kind = 'function';
				const bodyCloseOffset = findMatchingDelimiter(maskedText, bodyOpenOffset, '{', '}', rhsEndOffset);
				const scopeEndOffset = bodyCloseOffset < 0 ? rhsEndOffset : bodyCloseOffset;
				bodyRange = freezeRange(bodyOpenOffset + 1, scopeEndOffset);
				const namesByKind: Record<'scalar' | 'tabular', string[]> = { scalar: [], tabular: [] };
				for (const range of splitTopLevelRanges(maskedText, functionOpenOffset + 1, closeParenOffset)) {
					const parameterText = maskedText.slice(range.startOffset, range.endOffset);
					const parameterMatch = parameterText.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*/);
					if (!parameterMatch?.[1]) continue;
					const typeOffset = range.startOffset + parameterMatch[0].length;
					const parameterKind = maskedText[typeOffset] === '(' ? 'tabular' : 'scalar';
					namesByKind[parameterKind].push(parameterMatch[1].toLowerCase());
				}
				for (const parameterKind of ['scalar', 'tabular'] as const) {
					if (!namesByKind[parameterKind].length) continue;
					parameterScopes.push(Object.freeze({
						kind: parameterKind,
						startOffset: bodyOpenOffset + 1,
						endOffset: scopeEndOffset,
						namesLower: Object.freeze(namesByKind[parameterKind])
					}));
				}
			}
		}

		if (kind !== 'function') {
			sourceReference = readPhysicalSourceReference(maskedText, firstRhsOffset, rhsEndOffset);
			const sourceParameterKind = sourceReference
				? parameterScopes
					.filter((scope) =>
						sourceReference!.startOffset >= scope.startOffset &&
						sourceReference!.startOffset < scope.endOffset &&
						scope.namesLower.includes(sourceReference!.nameLower)
					)
					.sort((left, right) =>
						(left.endOffset - left.startOffset) - (right.endOffset - right.startOffset) ||
						right.startOffset - left.startOffset
					)[0]?.kind
				: undefined;
			const sourceExpressionStart = skipWhitespace(maskedText, firstRhsOffset, rhsEndOffset);
			let expressionStart = sourceExpressionStart;
			while (maskedText[expressionStart] === '(') {
				expressionStart = skipWhitespace(maskedText, expressionStart + 1, rhsEndOffset);
			}
			const expressionIdentifier = readIdentifier(maskedText, expressionStart, rhsEndOffset);
			const startsWithWrapper = !!expressionIdentifier && TABULAR_WRAPPERS.has(expressionIdentifier.nameLower);
			const sourceContinuationOffset = sourceReference
				? skipWhitespace(maskedText, sourceReference.endOffset, rhsEndOffset)
				: rhsEndOffset;
			const hasTabularContinuation = sourceContinuationOffset >= rhsEndOffset
				|| maskedText[sourceContinuationOffset] === '|'
				|| maskedText[sourceContinuationOffset] === ')';
			const visibleSourceBinding = sourceReference
				? [...bindings].reverse().find((binding) =>
					binding.nameLower === sourceReference!.nameLower &&
					binding.scopeStartOffset <= sourceReference!.startOffset &&
					sourceReference!.startOffset <= binding.scopeEndOffset
				)
				: undefined;
			if (
				sourceParameterKind === 'scalar' ||
				sourceParameterKind === 'query' ||
				visibleSourceBinding?.kind === 'scalar' ||
				(sourceReference && !startsWithWrapper && !hasTabularContinuation)
			) {
				sourceReference = undefined;
			}
			if (sourceReference) {
				kind = 'tabular';
			} else if (sourceParameterKind === 'tabular') {
				kind = 'tabular';
			} else if (
				(expressionIdentifier && (TABULAR_CONSTRUCTORS.has(expressionIdentifier.nameLower) || TABULAR_WRAPPERS.has(expressionIdentifier.nameLower)))
				|| isQualifiedTabularExpression(maskedText, expressionStart, rhsEndOffset)
			) {
				kind = 'tabular';
			}
		}

		bindings.push(Object.freeze({
			name,
			nameLower: name.toLowerCase(),
			startOffset: nameStartOffset,
			endOffset: nameStartOffset + name.length,
			rhsStartOffset,
			rhsEndOffset,
			scopeStartOffset: bindingEnd.scopeStartOffset,
			scopeEndOffset,
			rhsText: source.slice(rhsStartOffset, rhsEndOffset),
			maskedRhsText: maskedText.slice(rhsStartOffset, rhsEndOffset),
			kind,
			...(sourceReference ? { source: sourceReference } : {}),
			...(bodyRange ? { bodyRange } : {})
		}));
	}

	return {
		bindings: Object.freeze(bindings),
		parameterScopes: Object.freeze(parameterScopes)
	};
};

const buildTabularScopes = (
	bindings: readonly KqlLetBinding[],
	parameterScopes: readonly KqlParameterScope[],
	_textLength: number
): readonly KqlTabularScope[] => {
	const scopes: KqlTabularScope[] = parameterScopes
		.filter((scope) => scope.kind === 'tabular')
		.map((scope) => Object.freeze({
			kind: 'parameters' as const,
			startOffset: scope.startOffset,
			endOffset: scope.endOffset,
			namesLower: scope.namesLower
		}));
	for (const binding of bindings) {
		if (binding.kind !== 'tabular') continue;
		scopes.push(Object.freeze({
			kind: 'let',
			startOffset: binding.scopeStartOffset,
			endOffset: binding.scopeEndOffset,
			namesLower: Object.freeze([binding.nameLower])
		}));
	}
	scopes.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
	return Object.freeze(scopes);
};

const findVisibleLetBinding = (
	bindings: readonly KqlLetBinding[],
	nameLower: string,
	offset: number
): KqlLetBinding | undefined => bindings
	.filter((binding) =>
		binding.nameLower === nameLower &&
		binding.scopeStartOffset <= offset &&
		offset <= binding.scopeEndOffset
	)
	.sort((left, right) => right.scopeStartOffset - left.scopeStartOffset)[0];

const nameIsInTabularScope = (
	scopes: readonly KqlTabularScope[],
	nameLower: string,
	offset: number
): boolean => scopes.some((scope) =>
	offset >= scope.startOffset &&
	offset < scope.endOffset &&
	scope.namesLower.includes(nameLower)
);

const parseOperatorReference = (
	statement: KqlSourceStatement,
	operatorLocalOffset: number,
	operatorName: string
): KqlSourceReference | undefined => {
	const text = statement.maskedText;
	let offset = operatorLocalOffset + operatorName.length;
	const endOffset = text.length;
	offset = skipWhitespace(text, offset, endOffset);

	if (operatorName === 'join' || operatorName === 'lookup') {
		let consumedOption = true;
		while (consumedOption) {
			consumedOption = false;
			const optionMatch = text.slice(offset).match(/^(?:kind\s*=\s*[A-Za-z_][\w-]*|hint\.[A-Za-z_][\w-]*\s*=\s*[^\s)]+|withsource\s*=\s*[A-Za-z_][\w-]*)\b/i);
			if (optionMatch) {
				offset = skipWhitespace(text, offset + optionMatch[0].length, endOffset);
				consumedOption = true;
			}
		}
	}

	if (text[offset] === '(') {
		offset = skipWhitespace(text, offset + 1, endOffset);
	}
	const localReference = readPhysicalSourceReference(text, offset, endOffset);
	if (!localReference) {
		return undefined;
	}
	return Object.freeze({
		name: localReference.name,
		nameLower: localReference.nameLower,
		startOffset: statement.startOffset + localReference.startOffset,
		endOffset: statement.startOffset + localReference.endOffset
	});
};

const parseUnionReferences = (
	statement: KqlSourceStatement,
	operatorLocalOffset: number
): readonly KqlSourceReference[] => {
	const text = statement.maskedText;
	const endOffset = text.length;
	let offset = skipWhitespace(text, operatorLocalOffset + 'union'.length, endOffset);

	let consumedOption = true;
	while (consumedOption) {
		consumedOption = false;
		const optionMatch = text.slice(offset).match(
			/^(?:kind\s*=\s*(?:inner|outer)|withsource\s*=\s*[A-Za-z_][\w-]*|isfuzzy\s*=\s*(?:true|false)|hint\.[A-Za-z_][\w-]*\s*=\s*[^\s,)]+)/i
		);
		if (optionMatch) {
			offset = skipWhitespace(text, offset + optionMatch[0].length, endOffset);
			consumedOption = true;
		}
	}

	const references: KqlSourceReference[] = [];
	while (offset < endOffset) {
		while (offset < endOffset && (text[offset] === ',' || /\s/.test(text[offset]))) offset++;
		if (offset >= endOffset || text[offset] === '|' || text[offset] === ';') break;

		const localReference = readPhysicalSourceReference(text, offset, endOffset);
		if (localReference) {
			references.push(Object.freeze({
				name: localReference.name,
				nameLower: localReference.nameLower,
				startOffset: statement.startOffset + localReference.startOffset,
				endOffset: statement.startOffset + localReference.endOffset
			}));
		}

		let parenDepth = 0;
		let bracketDepth = 0;
		let braceDepth = 0;
		let advanced = false;
		for (let cursor = offset; cursor < endOffset; cursor++) {
			const character = text[cursor];
			if (character === '(') parenDepth++;
			else if (character === ')') {
				if (parenDepth === 0) return Object.freeze(references);
				parenDepth--;
			}
			else if (character === '[') bracketDepth++;
			else if (character === ']') {
				if (bracketDepth === 0) return Object.freeze(references);
				bracketDepth--;
			}
			else if (character === '{') braceDepth++;
			else if (character === '}') {
				if (braceDepth === 0) return Object.freeze(references);
				braceDepth--;
			}
			else if (character === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
				offset = cursor + 1;
				advanced = true;
				break;
			} else if (character === '|' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
				return Object.freeze(references);
			} else if (character === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
				return Object.freeze(references);
			}
		}
		if (!advanced) break;
	}
	return Object.freeze(references);
};

const splitRegionStatements = (
	source: string,
	maskedText: string,
	startOffset: number,
	endOffset: number
): readonly KqlSourceStatement[] => {
	const statements: KqlSourceStatement[] = [];
	let statementStartOffset = startOffset;
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	const addStatement = (statementEndOffset: number): void => {
		if (!maskedText.slice(statementStartOffset, statementEndOffset).trim()) return;
		statements.push(Object.freeze({
			startOffset: statementStartOffset,
			endOffset: statementEndOffset,
			text: source.slice(statementStartOffset, statementEndOffset),
			maskedText: maskedText.slice(statementStartOffset, statementEndOffset)
		}));
	};

	for (let offset = startOffset; offset < endOffset; offset++) {
		const character = maskedText[offset];
		if (character === '(') parenDepth++;
		else if (character === ')' && parenDepth > 0) parenDepth--;
		else if (character === '[') bracketDepth++;
		else if (character === ']' && bracketDepth > 0) bracketDepth--;
		else if (character === '{') braceDepth++;
		else if (character === '}' && braceDepth > 0) braceDepth--;
		else if (character === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			addStatement(offset);
			statementStartOffset = offset + 1;
		}
	}
	addStatement(endOffset);
	return Object.freeze(statements);
};

const buildManagementCommandRanges = (
	statements: readonly KqlSourceStatement[],
	maskedText: string
): readonly KqlSourceRange[] => {
	const ranges: KqlSourceRange[] = [];
	for (const statement of statements) {
		if (!statement.maskedText.trimStart().startsWith('.')) continue;
		const ownsQueryPayload = statement.maskedText.includes('<|');
		if (ownsQueryPayload) {
			ranges.push(freezeRange(statement.startOffset, maskedText.length));
			break;
		}
		const ownsFunctionBody = /^\s*\.(?:create|alter|create-or-alter)\b[\s\S]*?\bfunction\b/i.test(statement.maskedText);
		if (ownsFunctionBody) {
			const bodyOpenOffset = maskedText.indexOf('{', statement.startOffset);
			if (bodyOpenOffset < 0) {
				ranges.push(freezeRange(statement.startOffset, maskedText.length));
				break;
			}
			const bodyCloseOffset = findMatchingDelimiter(maskedText, bodyOpenOffset, '{', '}', maskedText.length);
			if (bodyCloseOffset < 0) {
				ranges.push(freezeRange(statement.startOffset, maskedText.length));
				break;
			}
			let endOffset = bodyCloseOffset + 1;
			while (endOffset < maskedText.length && /[ \t\r]/.test(maskedText[endOffset])) endOffset++;
			if (maskedText[endOffset] === ';') endOffset++;
			ranges.push(freezeRange(statement.startOffset, endOffset));
			continue;
		}
		ranges.push(freezeRange(statement.startOffset, statement.endOffset));
	}
	return Object.freeze(ranges);
};

const collectPhysicalTableReferences = (
	source: string,
	maskedText: string,
	statements: readonly KqlSourceStatement[],
	bindings: readonly KqlLetBinding[],
	tabularScopes: readonly KqlTabularScope[],
	parameterScopes: readonly KqlParameterScope[]
): readonly KqlSourceReference[] => {
	const candidates: KqlSourceReference[] = [];
	const managementCommandRanges = buildManagementCommandRanges(statements, maskedText);
	const isInsideManagementCommand = (offset: number): boolean => managementCommandRanges.some((range) =>
		range.startOffset <= offset && offset < range.endOffset
	);
	for (const binding of bindings) {
		if (binding.source && !isInsideManagementCommand(binding.startOffset)) {
			candidates.push(binding.source);
		}
	}

	const leadingSourceStatements: KqlSourceStatement[] = [...statements];
	for (const binding of bindings) {
		if (!binding.bodyRange || isInsideManagementCommand(binding.startOffset)) continue;
		leadingSourceStatements.push(...splitRegionStatements(
			source,
			maskedText,
			binding.bodyRange.startOffset,
			binding.bodyRange.endOffset
		));
	}

	for (const statement of leadingSourceStatements) {
		if (isInsideManagementCommand(statement.startOffset)) continue;
		const trimmed = statement.maskedText.trimStart();
		if (!/^let\b/i.test(trimmed) && !trimmed.startsWith('.')) {
			const reference = readPhysicalSourceReference(statement.maskedText, 0, statement.maskedText.length);
			if (reference) {
				candidates.push(Object.freeze({
					name: reference.name,
					nameLower: reference.nameLower,
					startOffset: statement.startOffset + reference.startOffset,
					endOffset: statement.startOffset + reference.endOffset
				}));
			}
		}

	}

	for (const statement of statements) {
		if (isInsideManagementCommand(statement.startOffset)) continue;
		for (const match of statement.maskedText.matchAll(/\b(join|lookup|from|union)\b/gi)) {
			if (typeof match.index !== 'number' || !match[1]) {
				continue;
			}
			if (match[1].toLowerCase() === 'union') {
				candidates.push(...parseUnionReferences(statement, match.index));
			} else {
				const reference = parseOperatorReference(statement, match.index, match[1].toLowerCase());
				if (reference) candidates.push(reference);
			}
		}
		for (const match of statement.maskedText.matchAll(/\btoscalar\s*\(/gi)) {
			if (typeof match.index !== 'number') continue;
			const reference = readScalarQuerySourceReference(
				statement.maskedText,
				match.index,
				statement.maskedText.length
			);
			if (!reference) continue;
			candidates.push(Object.freeze({
				name: reference.name,
				nameLower: reference.nameLower,
				startOffset: statement.startOffset + reference.startOffset,
				endOffset: statement.startOffset + reference.endOffset
			}));
		}
	}

	const references: KqlSourceReference[] = [];
	const seenRanges = new Set<string>();
	for (const candidate of candidates) {
		if (isInsideManagementCommand(candidate.startOffset)) continue;
		if (IGNORED_SOURCE_NAMES.has(candidate.nameLower)) {
			continue;
		}
		const isParameter = parameterScopes.some((scope) =>
			candidate.startOffset >= scope.startOffset &&
			candidate.startOffset < scope.endOffset &&
			scope.namesLower.includes(candidate.nameLower)
		);
		if (
			isParameter ||
			findVisibleLetBinding(bindings, candidate.nameLower, candidate.startOffset) ||
			nameIsInTabularScope(tabularScopes, candidate.nameLower, candidate.startOffset)
		) {
			continue;
		}
		const rangeKey = `${candidate.startOffset}:${candidate.endOffset}`;
		if (seenRanges.has(rangeKey)) {
			continue;
		}
		seenRanges.add(rangeKey);
		references.push(candidate);
	}
	references.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
	return Object.freeze(references);
};

export const analyzeKqlSource = (text: string): KqlSourceAnalysis => {
	const source = String(text ?? '');
	const lexical = maskSource(source);
	const protectedRanges = Object.freeze(
		[...lexical.commentRanges, ...lexical.stringRanges]
			.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)
	);
	const statements = splitStatements(source, lexical.maskedText, protectedRanges);
	const parsedBindings = parseLetBindings(source, lexical.maskedText, statements);
	const tabularScopes = buildTabularScopes(parsedBindings.bindings, parsedBindings.parameterScopes, source.length);
	const physicalTableReferences = collectPhysicalTableReferences(
		source,
		lexical.maskedText,
		statements,
		parsedBindings.bindings,
		tabularScopes,
		parsedBindings.parameterScopes
	);

	return Object.freeze({
		text: source,
		maskedText: lexical.maskedText,
		commentRanges: lexical.commentRanges,
		stringRanges: lexical.stringRanges,
		statements,
		letBindings: parsedBindings.bindings,
		tabularScopes,
		parameterScopes: parsedBindings.parameterScopes,
		physicalTableReferences
	});
};

export const isKqlTabularNameInScope = (
	analysis: KqlSourceAnalysis,
	name: string,
	offset: number
): boolean => nameIsInTabularScope(analysis.tabularScopes, String(name ?? '').toLowerCase(), offset);

export const isKqlNameInScope = (
	analysis: KqlSourceAnalysis,
	name: string,
	offset: number
): boolean => {
	const nameLower = String(name ?? '').toLowerCase();
	return !!findVisibleLetBinding(analysis.letBindings, nameLower, offset) || analysis.parameterScopes.some((scope) =>
		scope.startOffset <= offset &&
		offset < scope.endOffset &&
		scope.namesLower.includes(nameLower)
	);
};

export const resolveKqlLetSourceName = (
	analysis: KqlSourceAnalysis,
	name: string,
	atOffset: number = analysis.text.length
): string | undefined => {
	let currentBinding = findVisibleLetBinding(analysis.letBindings, String(name ?? '').toLowerCase(), atOffset);
	const visited = new Set<number>();
	for (let depth = 0; depth < analysis.letBindings.length + 1; depth++) {
		if (!currentBinding || visited.has(currentBinding.startOffset)) {
			return undefined;
		}
		visited.add(currentBinding.startOffset);
		if (!currentBinding.source) {
			return undefined;
		}
		const nextBinding = findVisibleLetBinding(
			analysis.letBindings,
			currentBinding.source.nameLower,
			currentBinding.source.startOffset
		);
		if (!nextBinding) {
			return currentBinding.source.name;
		}
		currentBinding = nextBinding;
	}
	return undefined;
};