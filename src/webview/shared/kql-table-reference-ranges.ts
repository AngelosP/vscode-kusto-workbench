export type AdmittedKqlTableReference = Readonly<{
	value: string;
	start: number;
	end: number;
}>;

export type KqlTableReferenceReplacement = Readonly<{
	start: number;
	end: number;
	text: string;
}>;

export const admitKqlTableReferenceRanges = (
	text: string,
	references: unknown
): readonly AdmittedKqlTableReference[] => {
	if (!Array.isArray(references)) return Object.freeze([]);
	const admitted: AdmittedKqlTableReference[] = [];
	const seen = new Set<string>();

	for (const candidate of references) {
		if (!candidate || typeof candidate !== 'object') return Object.freeze([]);
		const record = candidate as Record<string, unknown>;
		const value = typeof record.name === 'string' ? record.name : '';
		const start = record.startOffset;
		const end = record.endOffset;
		const numericStart = start as number;
		const numericEnd = end as number;
		const previousCharacter = text[numericStart - 1];
		const nextCharacter = text[numericEnd];
		const isIdentifierPart = (character: string | undefined): boolean =>
			character !== undefined && /[A-Za-z0-9_-]/.test(character);
		if (
			!/^([A-Za-z_][A-Za-z0-9_-]*)$/.test(value) ||
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			numericStart < 0 ||
			numericEnd > text.length ||
			numericEnd <= numericStart ||
			text.slice(numericStart, numericEnd) !== value ||
			isIdentifierPart(previousCharacter) ||
			previousCharacter === '.' ||
			isIdentifierPart(nextCharacter) ||
			nextCharacter === '.' ||
			nextCharacter === '*' ||
			nextCharacter === '('
		) {
			return Object.freeze([]);
		}
		const key = `${start}:${end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		admitted.push(Object.freeze({ value, start: numericStart, end: numericEnd }));
	}

	admitted.sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < admitted.length; index++) {
		if (admitted[index].start < admitted[index - 1].end) return Object.freeze([]);
	}
	return Object.freeze(admitted);
};

export const applyKqlTableReferenceReplacements = (
	text: string,
	replacements: readonly KqlTableReferenceReplacement[]
): string => {
	const ordered = [...replacements].sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 0; index < ordered.length; index++) {
		const replacement = ordered[index];
		if (
			!Number.isInteger(replacement.start) ||
			!Number.isInteger(replacement.end) ||
			replacement.start < 0 ||
			replacement.end > text.length ||
			replacement.end <= replacement.start ||
			(index > 0 && replacement.start < ordered[index - 1].end)
		) {
			return text;
		}
	}

	let result = text;
	for (let index = ordered.length - 1; index >= 0; index--) {
		const replacement = ordered[index];
		result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
	}
	return result;
};
