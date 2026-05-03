export type MonacoMarkerLike = Record<string, unknown>;

export type MonacoModelLike = {
	getLineContent?: (lineNumber: number) => string;
	getLineCount?: () => number;
};

function numberProperty(marker: MonacoMarkerLike, key: string): number | null {
	const value = marker[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getLineContent(model: MonacoModelLike | null | undefined, lineNumber: number): string | null {
	if (!model || !Number.isInteger(lineNumber) || lineNumber < 1) {
		return null;
	}
	try {
		const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : null;
		if (typeof lineCount === 'number' && Number.isFinite(lineCount) && lineNumber > lineCount) {
			return null;
		}
		if (typeof model.getLineContent === 'function') {
			return String(model.getLineContent(lineNumber) ?? '');
		}
	} catch {
		return null;
	}
	return null;
}

function isVisibleCharacter(char: string | undefined): boolean {
	return !!char && !/\s/u.test(char);
}

function findVisibleColumn(lineContent: string, collapsedColumn: number): { startColumn: number; endColumn: number } | null {
	const maxColumn = lineContent.length + 1;
	if (!Number.isInteger(collapsedColumn) || collapsedColumn < 1 || collapsedColumn > maxColumn) {
		return null;
	}

	const currentIndex = collapsedColumn - 1;
	if (currentIndex < lineContent.length && isVisibleCharacter(lineContent[currentIndex])) {
		return { startColumn: collapsedColumn, endColumn: collapsedColumn + 1 };
	}

	const previousIndex = collapsedColumn - 2;
	if (previousIndex >= 0 && isVisibleCharacter(lineContent[previousIndex])) {
		return { startColumn: collapsedColumn - 1, endColumn: collapsedColumn };
	}

	for (let distance = 1; distance < lineContent.length; distance += 1) {
		const forwardIndex = currentIndex + distance;
		if (forwardIndex < lineContent.length && isVisibleCharacter(lineContent[forwardIndex])) {
			return { startColumn: forwardIndex + 1, endColumn: forwardIndex + 2 };
		}

		const backwardIndex = previousIndex - distance;
		if (backwardIndex >= 0 && isVisibleCharacter(lineContent[backwardIndex])) {
			return { startColumn: backwardIndex + 1, endColumn: backwardIndex + 2 };
		}
	}

	return null;
}

export function __kustoNormalizeCollapsedMonacoMarkers<T extends readonly MonacoMarkerLike[]>(
	model: MonacoModelLike | null | undefined,
	markers: T
): T {
	if (!Array.isArray(markers) || markers.length === 0) {
		return markers;
	}

	let normalized: MonacoMarkerLike[] | null = null;
	markers.forEach((marker, index) => {
		const startLineNumber = numberProperty(marker, 'startLineNumber');
		const startColumn = numberProperty(marker, 'startColumn');
		const endLineNumber = numberProperty(marker, 'endLineNumber');
		const endColumn = numberProperty(marker, 'endColumn');
		if (
			startLineNumber === null || startColumn === null ||
			endLineNumber === null || endColumn === null ||
			startLineNumber !== endLineNumber || startColumn !== endColumn
		) {
			return;
		}

		const lineContent = getLineContent(model, startLineNumber);
		if (lineContent === null) {
			return;
		}
		const expanded = findVisibleColumn(lineContent, startColumn);
		if (!expanded || (expanded.startColumn === startColumn && expanded.endColumn === endColumn)) {
			return;
		}

		if (!normalized) {
			normalized = markers.slice() as MonacoMarkerLike[];
		}
		normalized[index] = {
			...marker,
			startColumn: expanded.startColumn,
			endColumn: expanded.endColumn,
		};
	});

	return (normalized || markers) as T;
}