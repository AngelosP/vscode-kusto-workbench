type UnknownRecord = Record<string, unknown>;

export type UrlContentParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type UrlContentAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: UrlContentParseResult<T> }>;

type FieldParseResult<T> = UrlContentParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type FetchUrlMessage = {
	type: 'fetchUrl';
	boxId: string;
	url: string;
	requestId: string;
};

type UrlContentIdentity = {
	boxId: string;
	requestId: string;
	requestedUrl: string;
};

type UrlContentSuccessBase = UrlContentIdentity & {
	type: 'urlContent';
	url: string;
	contentType: string;
	status: number;
	byteLength: number;
};

export type UrlContentMessage =
	| (UrlContentSuccessBase & {
			kind: 'image';
			dataUri: string;
	  })
	| (UrlContentSuccessBase & {
			kind: 'csv' | 'html' | 'text';
			body: string;
			truncated: boolean;
	  });

export type UrlErrorMessage = UrlContentIdentity & {
	type: 'urlError';
	error: string;
};

export type UrlContentWebviewMessage = FetchUrlMessage;
export type UrlContentHostMessage = UrlContentMessage | UrlErrorMessage;

const webviewMessageTypes = new Set(['fetchUrl']);
const hostMessageTypes = new Set(['urlContent', 'urlError']);

function failure<T>(error: string): UrlContentParseResult<T> {
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

function readOwnEnumerableDataProperty(
	input: UnknownRecord,
	key: string,
): FieldParseResult<unknown> {
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

function readNonblankString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readString(input, key);
	if (!field.ok) return field;
	return field.value.trim()
		? field
		: { ok: false, error: `${key} must not be blank.` };
}

function readNonnegativeSafeInteger(input: UnknownRecord, key: string): FieldParseResult<number> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'number' && Number.isSafeInteger(field.value) && field.value >= 0
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a non-negative safe integer.` };
}

function readSuccessfulHttpStatus(input: UnknownRecord): FieldParseResult<number> {
	const status = readNonnegativeSafeInteger(input, 'status');
	if (!status.ok) return status;
	return status.value >= 200 && status.value <= 299
		? status
		: { ok: false, error: 'status must be a successful HTTP status.' };
}

function hasOwn(input: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(input, key);
	} catch {
		return true;
	}
}

export function isUrlContentWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isUrlContentHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

function parseUrlContentWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): UrlContentParseResult<UrlContentWebviewMessage> {
	if (!isRecord(input)) return failure('URL content request must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'fetchUrl') return failure('Unknown URL content request type.');
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const url = readString(input, 'url');
	if (!url.ok) return failure(url.error);
	const requestId = readNonblankString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);
	return {
		ok: true,
		value: {
			type: 'fetchUrl',
			boxId: boxId.value,
			url: url.value,
			requestId: requestId.value,
		},
	};
}

function parseUrlContentHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): UrlContentParseResult<UrlContentHostMessage> {
	if (!isRecord(input)) return failure('URL content delivery must be an object.');
	if (!type.ok) return failure(type.error);
	if (type.value !== 'urlContent' && type.value !== 'urlError') {
		return failure('Unknown URL content delivery type.');
	}
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const requestId = readNonblankString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);

	if (type.value === 'urlError') {
		const requestedUrl = readString(input, 'requestedUrl');
		if (!requestedUrl.ok) return failure(requestedUrl.error);
		const error = readNonblankString(input, 'error');
		if (!error.ok) return failure(error.error);
		for (const key of ['url', 'contentType', 'status', 'kind', 'body', 'truncated', 'dataUri', 'byteLength']) {
			if (hasOwn(input, key)) return failure(`URL errors must not contain ${key}.`);
		}
		return {
			ok: true,
			value: {
				type: 'urlError',
				boxId: boxId.value,
				requestId: requestId.value,
				requestedUrl: requestedUrl.value,
				error: error.value,
			},
		};
	}

	const requestedUrl = readNonblankString(input, 'requestedUrl');
	if (!requestedUrl.ok) return failure(requestedUrl.error);
	const url = readNonblankString(input, 'url');
	if (!url.ok) return failure(url.error);
	const contentType = readString(input, 'contentType');
	if (!contentType.ok) return failure(contentType.error);
	const status = readSuccessfulHttpStatus(input);
	if (!status.ok) return failure(status.error);
	const byteLength = readNonnegativeSafeInteger(input, 'byteLength');
	if (!byteLength.ok) return failure(byteLength.error);
	if (hasOwn(input, 'error')) return failure('URL content must not contain an error.');
	const kind = readString(input, 'kind');
	if (!kind.ok) return failure(kind.error);
	if (kind.value !== 'image' && kind.value !== 'csv' && kind.value !== 'html' && kind.value !== 'text') {
		return failure('kind must be image, csv, html, or text.');
	}

	if (kind.value === 'image') {
		if (!contentType.value.trim()) return failure('contentType must not be blank.');
		const dataUri = readNonblankString(input, 'dataUri');
		if (!dataUri.ok) return failure(dataUri.error);
		if (hasOwn(input, 'body') || hasOwn(input, 'truncated')) {
			return failure('Image content must not contain body or truncated.');
		}
		return {
			ok: true,
			value: {
				type: 'urlContent',
				boxId: boxId.value,
				requestId: requestId.value,
				requestedUrl: requestedUrl.value,
				url: url.value,
				contentType: contentType.value,
				status: status.value,
				byteLength: byteLength.value,
				kind: 'image',
				dataUri: dataUri.value,
			},
		};
	} else {
		const body = readString(input, 'body');
		if (!body.ok) return failure(body.error);
		const truncated = readOwnEnumerableDataProperty(input, 'truncated');
		if (!truncated.ok) return failure(truncated.error);
		if (typeof truncated.value !== 'boolean') return failure('truncated must be a boolean.');
		if (hasOwn(input, 'dataUri')) return failure('Text content must not contain dataUri.');
		return {
			ok: true,
			value: {
				type: 'urlContent',
				boxId: boxId.value,
				requestId: requestId.value,
				requestedUrl: requestedUrl.value,
				url: url.value,
				contentType: contentType.value,
				status: status.value,
				byteLength: byteLength.value,
				kind: kind.value,
				body: body.value,
				truncated: truncated.value,
			},
		};
	}
}

export function admitUrlContentWebviewMessage(
	input: unknown,
): UrlContentAdmissionResult<UrlContentWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseUrlContentWebviewMessageWithType(input, inspection.type),
	};
}

export function admitUrlContentHostMessage(
	input: unknown,
): UrlContentAdmissionResult<UrlContentHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseUrlContentHostMessageWithType(input, inspection.type),
	};
}

export function parseUrlContentWebviewMessage(
	input: unknown,
): UrlContentParseResult<UrlContentWebviewMessage> {
	const admission = admitUrlContentWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown URL content request type.');
}

export function parseUrlContentHostMessage(
	input: unknown,
): UrlContentParseResult<UrlContentHostMessage> {
	const admission = admitUrlContentHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown URL content delivery type.');
}