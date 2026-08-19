export type KustoResultColumn = string | Readonly<{
	name: string;
	type?: string;
}>;

export type KustoResultMetadata = Readonly<Record<string, unknown>>;

export type KustoResultSet = Readonly<Record<string, unknown> & {
	resultIndex: number;
	columns: readonly KustoResultColumn[];
	rows: readonly (readonly unknown[])[];
	metadata: KustoResultMetadata;
}>;

export type KustoAdditionalResultSetV1 = KustoResultSet & Readonly<{
	resultIndex: number;
}>;

export type KustoAdditionalResultsV1 = Readonly<Record<string, unknown> & {
	version: 1;
	sets: readonly KustoAdditionalResultSetV1[];
}>;

export type KustoResultBatchV1 = Readonly<Record<string, unknown> & {
	columns: readonly KustoResultColumn[];
	rows: readonly (readonly unknown[])[];
	metadata: KustoResultMetadata;
	additionalResults?: KustoAdditionalResultsV1;
}>;

export type KustoResultSetInput = Readonly<{
	columns?: unknown;
	rows?: unknown;
	metadata?: unknown;
}>;

export type KustoResultBatchParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

type CaptureBudget = {
	values: number;
	stringCharacters: number;
};

const MAX_RESULT_SETS = 256;
const MAX_COLUMNS_PER_SET = 16_384;
const MAX_ROWS_PER_SET = 2_000_000;
const MAX_CAPTURE_VALUES = 20_000_000;
const MAX_CAPTURE_DEPTH = 64;
const MAX_STRING_CHARACTERS = 256 * 1024 * 1024;

function failure<T>(error: string): KustoResultBatchParseResult<T> {
	return { ok: false, error };
}

function isCanonicalRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown[]): boolean {
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
	}
	return true;
}

function captureValue(
	value: unknown,
	budget: CaptureBudget,
	active: Set<object>,
	depth: number,
): KustoResultBatchParseResult<unknown> {
	if (++budget.values > MAX_CAPTURE_VALUES) return failure('Kusto result batch contains too many values.');
	if (depth > MAX_CAPTURE_DEPTH) return failure('Kusto result batch exceeds the maximum nesting depth.');
	if (typeof value === 'string') {
		budget.stringCharacters += value.length;
		return budget.stringCharacters <= MAX_STRING_CHARACTERS
			? { ok: true, value }
			: failure('Kusto result batch contains too much string data.');
	}
	if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
		return { ok: true, value };
	}
	if (value instanceof Date) return { ok: true, value: new Date(value.getTime()) };
	if (!value || typeof value !== 'object') return failure('Kusto result batch contains an unsupported value.');
	if (active.has(value)) return failure('Kusto result batch must not contain cycles.');
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (!isDenseArray(value)) return failure('Kusto result batch arrays must be dense.');
			const captured: unknown[] = [];
			for (const item of value) {
				const result = captureValue(item, budget, active, depth + 1);
				if (!result.ok) return result;
				captured.push(result.value);
			}
			return { ok: true, value: Object.freeze(captured) };
		}
		if (!isCanonicalRecord(value)) return failure('Kusto result batch objects must use a canonical prototype.');
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const captured: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== 'string') return failure('Kusto result batch objects must use string keys.');
			const descriptor = descriptors[key];
			if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure('Kusto result batch fields must be own enumerable data properties.');
			}
			const result = captureValue(descriptor.value, budget, active, depth + 1);
			if (!result.ok) return result;
			captured[key] = result.value;
		}
		return { ok: true, value: Object.freeze(captured) };
	} catch {
		return failure('Kusto result batch could not be captured.');
	} finally {
		active.delete(value);
	}
}

function captureRecord(
	value: unknown,
	label: string,
	budget: CaptureBudget,
): KustoResultBatchParseResult<Readonly<Record<string, unknown>>> {
	if (!isCanonicalRecord(value)) return failure(`${label} must be an object record.`);
	const captured = captureValue(value, budget, new Set<object>(), 0);
	return captured.ok
		? { ok: true, value: captured.value as Readonly<Record<string, unknown>> }
		: captured;
}

function captureExtensions(
	value: unknown,
	knownKeys: ReadonlySet<string>,
	budget: CaptureBudget,
): KustoResultBatchParseResult<Readonly<Record<string, unknown>>> {
	if (!isCanonicalRecord(value)) return failure('Kusto result set must be an object record.');
	try {
		const extensions: Record<string, unknown> = {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (knownKeys.has(key)) continue;
			if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure('Kusto result-set fields must be own enumerable data properties.');
			}
			const captured = captureValue(descriptor.value, budget, new Set<object>(), 0);
			if (!captured.ok) return captured;
			extensions[key] = captured.value;
		}
		return { ok: true, value: Object.freeze(extensions) };
	} catch {
		return failure('Kusto result-set extensions could not be captured.');
	}
}

function captureColumns(
	value: unknown,
	budget: CaptureBudget,
): KustoResultBatchParseResult<readonly KustoResultColumn[]> {
	if (!Array.isArray(value) || !isDenseArray(value)) return failure('Kusto result columns must be a dense array.');
	if (value.length > MAX_COLUMNS_PER_SET) return failure('Kusto result contains too many columns.');
	const columns: KustoResultColumn[] = [];
	for (const column of value) {
		if (typeof column === 'string') {
			const captured = captureValue(column, budget, new Set<object>(), 0);
			if (!captured.ok) return captured;
			columns.push(column);
			continue;
		}
		if (!isCanonicalRecord(column) || typeof column.name !== 'string'
			|| (column.type !== undefined && typeof column.type !== 'string')) {
			return failure('Kusto result columns must be strings or named column records.');
		}
		const captured = captureValue(column, budget, new Set<object>(), 0);
		if (!captured.ok) return captured;
		columns.push(captured.value as KustoResultColumn);
	}
	return { ok: true, value: Object.freeze(columns) };
}

function captureRows(
	value: unknown,
	columnCount: number,
	budget: CaptureBudget,
): KustoResultBatchParseResult<readonly (readonly unknown[])[]> {
	if (!Array.isArray(value) || !isDenseArray(value)) return failure('Kusto result rows must be a dense array.');
	if (value.length > MAX_ROWS_PER_SET) return failure('Kusto result contains too many rows.');
	const rows: (readonly unknown[])[] = [];
	for (const sourceRow of value) {
		if (!Array.isArray(sourceRow)) return failure('Kusto result rows must contain only arrays.');
		const row = sourceRow;
		if (!isDenseArray(row)) return failure('Kusto result rows must be dense arrays.');
		const projected: unknown[] = [];
		for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
			const captured = captureValue(row[columnIndex], budget, new Set<object>(), 0);
			if (!captured.ok) return captured;
			projected.push(captured.value);
		}
		rows.push(Object.freeze(projected));
	}
	return { ok: true, value: Object.freeze(rows) };
}

function captureResultSet(
	value: KustoResultSetInput,
	resultIndex: number,
	defaultMetadata: unknown,
	budget: CaptureBudget,
	additionalKnownKeys: readonly string[] = [],
): KustoResultBatchParseResult<KustoResultSet> {
	if (!Number.isSafeInteger(resultIndex) || resultIndex < 0) return failure('Kusto result index is invalid.');
	const extensions = captureExtensions(
		value,
		new Set(['resultIndex', 'columns', 'rows', 'metadata', ...additionalKnownKeys]),
		budget,
	);
	if (!extensions.ok) return extensions;
	const columns = captureColumns(value.columns ?? [], budget);
	if (!columns.ok) return columns;
	const rows = captureRows(value.rows ?? [], columns.value.length, budget);
	if (!rows.ok) return rows;
	const baseMetadata = captureRecord(defaultMetadata ?? {}, 'Kusto result metadata', budget);
	if (!baseMetadata.ok) return baseMetadata;
	const ownMetadata = captureRecord(value.metadata ?? {}, 'Kusto result metadata', budget);
	if (!ownMetadata.ok) return ownMetadata;
	return {
		ok: true,
		value: Object.freeze({
			...extensions.value,
			resultIndex,
			columns: columns.value,
			rows: rows.value,
			metadata: Object.freeze({ ...baseMetadata.value, ...ownMetadata.value }),
		}),
	};
}

export function createKustoResultBatch(
	resultSets: readonly KustoResultSetInput[],
	defaultMetadata: unknown = {},
): KustoResultBatchParseResult<KustoResultBatchV1> {
	if (!Array.isArray(resultSets) || !isDenseArray(resultSets as KustoResultSetInput[])) {
		return failure('Kusto result sets must be a dense array.');
	}
	if (resultSets.length > MAX_RESULT_SETS) return failure('Kusto result batch contains too many result sets.');
	const physicalResultSetCount = resultSets.length;
	const sourceSets = physicalResultSetCount > 0
		? resultSets
		: [{ columns: [], rows: [], metadata: { physicalResultSetCount: 0 } }];
	const budget: CaptureBudget = { values: 0, stringCharacters: 0 };
	const capturedSets: KustoResultSet[] = [];
	for (let resultIndex = 0; resultIndex < sourceSets.length; resultIndex++) {
		const captured = captureResultSet(sourceSets[resultIndex], resultIndex, defaultMetadata, budget);
		if (!captured.ok) return captured;
		capturedSets.push(captured.value);
	}
	const primary = capturedSets[0];
	const batch: Record<string, unknown> = {
		columns: primary.columns,
		rows: primary.rows,
		metadata: primary.metadata,
	};
	if (capturedSets.length > 1) {
		batch.additionalResults = Object.freeze({
			version: 1 as const,
			sets: Object.freeze(capturedSets.slice(1)),
		});
	}
	return { ok: true, value: Object.freeze(batch) as KustoResultBatchV1 };
}

export function parseKustoResultBatch(value: unknown): KustoResultBatchParseResult<KustoResultBatchV1> {
	if (!isCanonicalRecord(value)) return failure('Kusto result batch must be an object record.');
	const budget: CaptureBudget = { values: 0, stringCharacters: 0 };
	const primary = captureResultSet(value, 0, {}, budget, ['additionalResults']);
	if (!primary.ok) return primary;
	const additional = value.additionalResults;
	const sets: KustoResultSet[] = [primary.value];
	let capturedAdditional: KustoAdditionalResultsV1 | undefined;
	if (additional !== undefined) {
		if (!isCanonicalRecord(additional) || additional.version !== 1
			|| !Array.isArray(additional.sets) || !isDenseArray(additional.sets)) {
			return failure('Kusto additional results must use version 1 with a dense sets array.');
		}
		if (additional.sets.length === 0 || additional.sets.length >= MAX_RESULT_SETS) {
			return failure('Kusto additional results must contain a bounded nonempty sets array.');
		}
		const capturedSets: KustoAdditionalResultSetV1[] = [];
		for (let offset = 0; offset < additional.sets.length; offset++) {
			const item = additional.sets[offset];
			const expectedIndex = offset + 1;
			if (!isCanonicalRecord(item) || item.resultIndex !== expectedIndex) {
				return failure('Kusto additional result indexes must be contiguous and ordered.');
			}
			const captured = captureResultSet(item, expectedIndex, {}, budget);
			if (!captured.ok) return captured;
			capturedSets.push(captured.value);
			sets.push(captured.value);
		}
		const capturedEnvelope = captureExtensions(additional, new Set(['version', 'sets']), budget);
		if (!capturedEnvelope.ok) return capturedEnvelope;
		capturedAdditional = Object.freeze({
			...capturedEnvelope.value,
			version: 1,
			sets: Object.freeze(capturedSets),
		}) as KustoAdditionalResultsV1;
	}
	const capturedRoot = captureExtensions(
		value,
		new Set(['resultIndex', 'columns', 'rows', 'metadata', 'additionalResults']),
		budget,
	);
	if (!capturedRoot.ok) return capturedRoot;
	return {
		ok: true,
		value: Object.freeze({
			...capturedRoot.value,
			columns: primary.value.columns,
			rows: primary.value.rows,
			metadata: primary.value.metadata,
			...(capturedAdditional ? { additionalResults: capturedAdditional } : {}),
		}) as KustoResultBatchV1,
	};
}

export function getKustoResultSets(value: KustoResultBatchV1): readonly KustoResultSet[] {
	return Object.freeze([
		Object.freeze({
			resultIndex: 0,
			columns: value.columns,
			rows: value.rows,
			metadata: value.metadata,
		}),
		...(value.additionalResults?.sets ?? []),
	]);
}

export type SerializedKustoResultBatch = Readonly<{
	json: string | null;
	truncated: boolean;
	rowCounts: readonly number[];
}>;

function utf8Length(value: string): number {
	try {
		return typeof TextEncoder === 'undefined'
			? value.length * 2
			: new TextEncoder().encode(value).length;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function fairRowCounts(totalRows: number, lengths: readonly number[]): number[] {
	const counts = lengths.map(() => 0);
	let assigned = 0;
	while (assigned < totalRows) {
		let advanced = false;
		for (let resultIndex = 0; resultIndex < lengths.length && assigned < totalRows; resultIndex++) {
			if (counts[resultIndex] >= lengths[resultIndex]) continue;
			counts[resultIndex]++;
			assigned++;
			advanced = true;
		}
		if (!advanced) break;
	}
	return counts;
}

function persistedSet(set: KustoResultSet, rowCount: number): Record<string, unknown> {
	const totalRows = set.rows.length;
	const truncated = rowCount < totalRows;
	return {
		...set,
		columns: set.columns,
		rows: set.rows.slice(0, rowCount),
		metadata: truncated
			? {
				...set.metadata,
				persistedTruncated: true,
				persistedTotalRows: totalRows,
				persistedRows: rowCount,
			}
			: set.metadata,
	};
}

function persistenceCandidate(
	batch: KustoResultBatchV1,
	sets: readonly KustoResultSet[],
	rowCounts: readonly number[],
): Record<string, unknown> {
	const primary = persistedSet(sets[0], rowCounts[0]);
	const { resultIndex: _primaryResultIndex, ...primaryFields } = primary;
	const { additionalResults: _additionalResults, ...rootExtensions } = batch;
	const candidate: Record<string, unknown> = {
		...rootExtensions,
		...primaryFields,
	};
	if (sets.length > 1) {
		candidate.additionalResults = {
			...(batch.additionalResults ?? {}),
			version: 1,
			sets: sets.slice(1).map((set, offset) => persistedSet(set, rowCounts[offset + 1])),
		};
	}
	return candidate;
}

export function serializeKustoResultBatchForPersistence(
	batch: KustoResultBatchV1,
	maxBytes = 5 * 1024 * 1024,
	maxRowsHardCap = 5_000,
): SerializedKustoResultBatch {
	const parsed = parseKustoResultBatch(batch);
	if (!parsed.ok || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
		|| !Number.isSafeInteger(maxRowsHardCap) || maxRowsHardCap < 0) {
		return { json: null, truncated: false, rowCounts: [] };
	}
	const sets = getKustoResultSets(parsed.value);
	const lengths = sets.map(set => set.rows.length);
	const totalRows = lengths.reduce((sum, length) => sum + length, 0);
	if (totalRows <= maxRowsHardCap) {
		try {
			const json = JSON.stringify(parsed.value);
			if (utf8Length(json) <= maxBytes) {
				return { json, truncated: false, rowCounts: lengths };
			}
		} catch {
			return { json: null, truncated: false, rowCounts: [] };
		}
	}

	let low = 0;
	let high = Math.min(totalRows, maxRowsHardCap);
	let bestJson: string | null = null;
	let bestCounts: number[] = [];
	while (low <= high) {
		const candidateRows = Math.floor((low + high) / 2);
		const counts = fairRowCounts(candidateRows, lengths);
		let json: string;
		try {
			json = JSON.stringify(persistenceCandidate(parsed.value, sets, counts));
		} catch {
			return { json: null, truncated: false, rowCounts: [] };
		}
		if (utf8Length(json) <= maxBytes) {
			bestJson = json;
			bestCounts = counts;
			low = candidateRows + 1;
		} else {
			high = candidateRows - 1;
		}
	}
	if (bestJson === null) return { json: null, truncated: false, rowCounts: [] };
	return {
		json: bestJson,
		truncated: bestCounts.some((count, resultIndex) => count < lengths[resultIndex]),
		rowCounts: Object.freeze(bestCounts),
	};
}