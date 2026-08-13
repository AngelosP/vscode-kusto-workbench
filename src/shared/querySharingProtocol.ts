type UnknownRecord = Record<string, unknown>;

export type QuerySharingParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type QuerySharingAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: QuerySharingParseResult<T> }>;

type FieldParseResult<T> = QuerySharingParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type CopyAdeLinkMessage = {
	type: 'copyAdeLink';
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
};

export type ShareToClipboardMessage = {
	type: 'shareToClipboard';
	engine: 'kusto' | 'sql';
	boxId: string;
	includeTitle: boolean;
	includeQuery: boolean;
	includeResults: boolean;
	sectionName: string;
	queryText: string;
	connectionId: string;
	database: string;
	columns: string[];
	rowsData: string[][];
	totalRows: number;
};

export type ShareContentReadyMessage = {
	type: 'shareContentReady';
	html: string;
	text: string;
};

export type QuerySharingWebviewMessage = CopyAdeLinkMessage | ShareToClipboardMessage;
export type QuerySharingHostMessage = ShareContentReadyMessage;

const webviewMessageTypes = new Set(['copyAdeLink', 'shareToClipboard']);
const hostMessageTypes = new Set(['shareContentReady']);

function failure<T>(error: string): QuerySharingParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	if (!value || typeof value !== 'object') return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): KnownTypeInspection {
	const inputType = typeof input;
	if (!input || (inputType !== 'object' && inputType !== 'function')) return { recognized: false };
	try {
		let owner: object | null = input as object;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) {
				return { recognized: true, type: { ok: false, error: 'type prototype inspection was cyclic.' } };
			}
			seen.add(owner);
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'type');
			if (descriptor) {
				const isDataProperty = Object.prototype.hasOwnProperty.call(descriptor, 'value');
				if (isDataProperty && typeof descriptor.value === 'string' && !types.has(descriptor.value)) {
					return { recognized: false };
				}
				if (owner !== input || !descriptor.enumerable || !isDataProperty) {
					return {
						recognized: true,
						type: { ok: false, error: 'type must be an own enumerable data property.' },
					};
				}
				return typeof descriptor.value === 'string'
					? { recognized: true, type: { ok: true, value: descriptor.value } }
					: { recognized: true, type: { ok: false, error: 'type must be a string.' } };
			}
			owner = Object.getPrototypeOf(owner);
		}
		return { recognized: true, type: { ok: false, error: 'type could not be resolved.' } };
	} catch {
		return { recognized: true, type: { ok: false, error: 'type could not be inspected.' } };
	}
}

function readOwnEnumerableDataProperty(input: UnknownRecord, key: string): FieldParseResult<unknown> {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return { ok: false, error: `${key} must be an own enumerable data property.` };
		}
		return { ok: true, value: descriptor.value };
	} catch {
		return { ok: false, error: `${key} could not be inspected.` };
	}
}

function readString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'string'
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a string.` };
}

function readBoolean(input: UnknownRecord, key: string): FieldParseResult<boolean> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'boolean'
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a boolean.` };
}

function readNonnegativeSafeInteger(input: UnknownRecord, key: string): FieldParseResult<number> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'number' && Number.isSafeInteger(field.value) && field.value >= 0
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a non-negative safe integer.` };
}

function captureDenseArray(value: unknown, key: string): FieldParseResult<unknown[]> {
	try {
		if (!Array.isArray(value)) return failure(`${key} must be an array.`);
		if (Object.getPrototypeOf(value) !== Array.prototype
			|| Object.getOwnPropertyDescriptor(value, Symbol.iterator)) {
			return failure(`${key} must use the canonical array prototype and iterator.`);
		}
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		if (!lengthDescriptor
			|| !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
			|| typeof lengthDescriptor.value !== 'number'
			|| !Number.isSafeInteger(lengthDescriptor.value)
			|| lengthDescriptor.value < 0) {
			return failure(`${key} must have a valid length.`);
		}
		const captured: unknown[] = [];
		for (let index = 0; index < lengthDescriptor.value; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be dense and contain only enumerable data entries.`);
			}
			captured.push(descriptor.value);
		}
		return { ok: true, value: captured };
	} catch {
		return failure(`${key} could not be inspected.`);
	}
}

function readDenseStringArray(input: UnknownRecord, key: string): FieldParseResult<string[]> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return captureDenseStringArray(field.value, key);
}

function captureDenseStringArray(value: unknown, key: string): FieldParseResult<string[]> {
	const array = captureDenseArray(value, key);
	if (!array.ok) return array;
	const captured: string[] = [];
	for (let index = 0; index < array.value.length; index++) {
		const item = array.value[index];
		if (typeof item !== 'string') return failure(`${key}[${index}] must be a string.`);
		captured.push(item);
	}
	return { ok: true, value: captured };
}

function readDenseStringRows(input: UnknownRecord, key: string): FieldParseResult<string[][]> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	const rows = captureDenseArray(field.value, key);
	if (!rows.ok) return rows;
	const captured: string[][] = [];
	for (let index = 0; index < rows.value.length; index++) {
		const row = captureDenseStringArray(rows.value[index], `${key}[${index}]`);
		if (!row.ok) return row;
		captured.push(row.value);
	}
	return { ok: true, value: captured };
}

function parseQuerySharingWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): QuerySharingParseResult<QuerySharingWebviewMessage> {
	if (!isRecord(input)) return failure('Query sharing request must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'copyAdeLink' && type.value !== 'shareToClipboard') {
		return failure('Unknown query sharing request type.');
	}

	const boxId = readString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const connectionId = readString(input, 'connectionId');
	if (!connectionId.ok) return failure(connectionId.error);
	const database = readString(input, 'database');
	if (!database.ok) return failure(database.error);

	if (type.value === 'copyAdeLink') {
		const query = readString(input, 'query');
		if (!query.ok) return failure(query.error);
		return {
			ok: true,
			value: {
				type: 'copyAdeLink',
				query: query.value,
				connectionId: connectionId.value,
				database: database.value,
				boxId: boxId.value,
			},
		};
	}

	const engine = readString(input, 'engine');
	if (!engine.ok) return failure(engine.error);
	if (engine.value !== 'kusto' && engine.value !== 'sql') return failure('engine must be kusto or sql.');
	const includeTitle = readBoolean(input, 'includeTitle');
	if (!includeTitle.ok) return failure(includeTitle.error);
	const includeQuery = readBoolean(input, 'includeQuery');
	if (!includeQuery.ok) return failure(includeQuery.error);
	const includeResults = readBoolean(input, 'includeResults');
	if (!includeResults.ok) return failure(includeResults.error);
	const sectionName = readString(input, 'sectionName');
	if (!sectionName.ok) return failure(sectionName.error);
	const queryText = readString(input, 'queryText');
	if (!queryText.ok) return failure(queryText.error);
	const columns = readDenseStringArray(input, 'columns');
	if (!columns.ok) return failure(columns.error);
	const rowsData = readDenseStringRows(input, 'rowsData');
	if (!rowsData.ok) return failure(rowsData.error);
	const totalRows = readNonnegativeSafeInteger(input, 'totalRows');
	if (!totalRows.ok) return failure(totalRows.error);
	return {
		ok: true,
		value: {
			type: 'shareToClipboard',
			engine: engine.value,
			boxId: boxId.value,
			includeTitle: includeTitle.value,
			includeQuery: includeQuery.value,
			includeResults: includeResults.value,
			sectionName: sectionName.value,
			queryText: queryText.value,
			connectionId: connectionId.value,
			database: database.value,
			columns: columns.value,
			rowsData: rowsData.value,
			totalRows: totalRows.value,
		},
	};
}

function parseQuerySharingHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): QuerySharingParseResult<QuerySharingHostMessage> {
	if (!isRecord(input)) return failure('Query sharing delivery must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'shareContentReady') return failure('Unknown query sharing delivery type.');
	const html = readString(input, 'html');
	if (!html.ok) return failure(html.error);
	const text = readString(input, 'text');
	if (!text.ok) return failure(text.error);
	return {
		ok: true,
		value: { type: 'shareContentReady', html: html.value, text: text.value },
	};
}

export function isQuerySharingWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isQuerySharingHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitQuerySharingWebviewMessage(
	input: unknown,
): QuerySharingAdmissionResult<QuerySharingWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseQuerySharingWebviewMessageWithType(input, inspection.type),
	};
}

export function admitQuerySharingHostMessage(
	input: unknown,
): QuerySharingAdmissionResult<QuerySharingHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseQuerySharingHostMessageWithType(input, inspection.type),
	};
}

export function parseQuerySharingWebviewMessage(
	input: unknown,
): QuerySharingParseResult<QuerySharingWebviewMessage> {
	const admission = admitQuerySharingWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown query sharing request type.');
}

export function parseQuerySharingHostMessage(
	input: unknown,
): QuerySharingParseResult<QuerySharingHostMessage> {
	const admission = admitQuerySharingHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown query sharing delivery type.');
}