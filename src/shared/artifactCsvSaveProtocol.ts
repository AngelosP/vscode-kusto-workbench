type UnknownRecord = Record<string, unknown>;

export type ArtifactCsvSaveParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type ArtifactCsvSaveAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; parsed: ArtifactCsvSaveParseResult<T> }>;

type FieldParseResult<T> = ArtifactCsvSaveParseResult<T>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{ recognized: true; type: FieldParseResult<string> }>;

export type RequestArtifactCsvSaveMessage = {
	type: 'requestArtifactCsvSave';
	requestId: string;
	boxId: string;
	artifactId: string;
	suggestedFileName?: string;
};

export type ArtifactCsvSaveDataMessage =
	| {
			type: 'artifactCsvSaveData';
			requestId: string;
			boxId: string;
			artifactId: string;
			accepted: true;
			csv: string;
	  }
	| {
			type: 'artifactCsvSaveData';
			requestId: string;
			boxId: string;
			artifactId: string;
			accepted: false;
	  };

export type CancelArtifactCsvSaveIntentMessage = {
	type: 'cancelArtifactCsvSaveIntent';
	requestId: string;
};

export type RequestArtifactCsvSaveDataMessage = {
	type: 'requestArtifactCsvSaveData';
	requestId: string;
	exportId: string;
	boxId: string;
	artifactId: string;
};

export type CancelArtifactCsvSaveMessage = {
	type: 'cancelArtifactCsvSave';
	exportId: string;
};

export type ArtifactCsvSaveWebviewMessage =
	| RequestArtifactCsvSaveMessage
	| ArtifactCsvSaveDataMessage
	| CancelArtifactCsvSaveIntentMessage;

export type ArtifactCsvSaveHostMessage =
	| RequestArtifactCsvSaveDataMessage
	| CancelArtifactCsvSaveMessage;

const webviewMessageTypes = new Set([
	'requestArtifactCsvSave',
	'artifactCsvSaveData',
	'cancelArtifactCsvSaveIntent',
]);
const hostMessageTypes = new Set([
	'requestArtifactCsvSaveData',
	'cancelArtifactCsvSave',
]);

function failure<T>(error: string): ArtifactCsvSaveParseResult<T> {
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

function readNonblankString(input: UnknownRecord, key: string): FieldParseResult<string> {
	const field = readString(input, key);
	if (!field.ok) return field;
	return field.value.trim()
		? field
		: { ok: false, error: `${key} must not be blank.` };
}

function readOptionalString(input: UnknownRecord, key: string): FieldParseResult<string | undefined> {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(input, key);
	} catch {
		return { ok: false, error: `${key} could not be inspected.` };
	}
	if (!descriptor) return { ok: true, value: undefined };
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return { ok: false, error: `${key} must be an own enumerable data property.` };
	}
	return descriptor.value === undefined || typeof descriptor.value === 'string'
		? { ok: true, value: descriptor.value }
		: { ok: false, error: `${key} must be a string when provided.` };
}

function readBoolean(input: UnknownRecord, key: string): FieldParseResult<boolean> {
	const field = readOwnEnumerableDataProperty(input, key);
	if (!field.ok) return field;
	return typeof field.value === 'boolean'
		? { ok: true, value: field.value }
		: { ok: false, error: `${key} must be a boolean.` };
}

function hasOwn(input: UnknownRecord, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(input, key);
	} catch {
		return true;
	}
}

function parseArtifactCsvSaveWebviewMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): ArtifactCsvSaveParseResult<ArtifactCsvSaveWebviewMessage> {
	if (!isRecord(input)) return failure('Artifact CSV save request must be an object.');
	if (!type.ok) return failure(type.error);

	if (type.value === 'cancelArtifactCsvSaveIntent') {
		const requestId = readNonblankString(input, 'requestId');
		if (!requestId.ok) return failure(requestId.error);
		return { ok: true, value: { type: 'cancelArtifactCsvSaveIntent', requestId: requestId.value } };
	}

	const requestId = readNonblankString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const artifactId = readNonblankString(input, 'artifactId');
	if (!artifactId.ok) return failure(artifactId.error);

	if (type.value === 'requestArtifactCsvSave') {
		const suggestedFileName = readOptionalString(input, 'suggestedFileName');
		if (!suggestedFileName.ok) return failure(suggestedFileName.error);
		return {
			ok: true,
			value: {
				type: 'requestArtifactCsvSave',
				requestId: requestId.value,
				boxId: boxId.value,
				artifactId: artifactId.value,
				...(suggestedFileName.value === undefined
					? {}
					: { suggestedFileName: suggestedFileName.value }),
			},
		};
	}

	if (type.value !== 'artifactCsvSaveData') {
		return failure('Unknown artifact CSV save request type.');
	}
	const accepted = readBoolean(input, 'accepted');
	if (!accepted.ok) return failure(accepted.error);
	if (!accepted.value) {
		if (hasOwn(input, 'csv')) return failure('Rejected artifact CSV data must not contain csv.');
		return {
			ok: true,
			value: {
				type: 'artifactCsvSaveData', requestId: requestId.value,
				boxId: boxId.value, artifactId: artifactId.value, accepted: false,
			},
		};
	}
	const csv = readString(input, 'csv');
	if (!csv.ok) return failure(csv.error);
	return {
		ok: true,
		value: {
			type: 'artifactCsvSaveData', requestId: requestId.value,
			boxId: boxId.value, artifactId: artifactId.value, accepted: true, csv: csv.value,
		},
	};
}

function parseArtifactCsvSaveHostMessageWithType(
	input: unknown,
	type: FieldParseResult<string>,
): ArtifactCsvSaveParseResult<ArtifactCsvSaveHostMessage> {
	if (!isRecord(input)) return failure('Artifact CSV save delivery must be an object.');
	if (!type.ok) return failure(type.error);

	if (type.value === 'cancelArtifactCsvSave') {
		const exportId = readNonblankString(input, 'exportId');
		if (!exportId.ok) return failure(exportId.error);
		return { ok: true, value: { type: 'cancelArtifactCsvSave', exportId: exportId.value } };
	}
	if (type.value !== 'requestArtifactCsvSaveData') {
		return failure('Unknown artifact CSV save delivery type.');
	}
	const requestId = readNonblankString(input, 'requestId');
	if (!requestId.ok) return failure(requestId.error);
	const exportId = readNonblankString(input, 'exportId');
	if (!exportId.ok) return failure(exportId.error);
	const boxId = readNonblankString(input, 'boxId');
	if (!boxId.ok) return failure(boxId.error);
	const artifactId = readNonblankString(input, 'artifactId');
	if (!artifactId.ok) return failure(artifactId.error);
	return {
		ok: true,
		value: {
			type: 'requestArtifactCsvSaveData', requestId: requestId.value,
			exportId: exportId.value, boxId: boxId.value, artifactId: artifactId.value,
		},
	};
}

export function isArtifactCsvSaveWebviewMessageType(input: unknown): boolean {
	return inspectKnownType(input, webviewMessageTypes).recognized;
}

export function isArtifactCsvSaveHostMessageType(input: unknown): boolean {
	return inspectKnownType(input, hostMessageTypes).recognized;
}

export function admitArtifactCsvSaveWebviewMessage(
	input: unknown,
): ArtifactCsvSaveAdmissionResult<ArtifactCsvSaveWebviewMessage> {
	const inspection = inspectKnownType(input, webviewMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseArtifactCsvSaveWebviewMessageWithType(input, inspection.type),
	};
}

export function admitArtifactCsvSaveHostMessage(
	input: unknown,
): ArtifactCsvSaveAdmissionResult<ArtifactCsvSaveHostMessage> {
	const inspection = inspectKnownType(input, hostMessageTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		parsed: parseArtifactCsvSaveHostMessageWithType(input, inspection.type),
	};
}

export function parseArtifactCsvSaveWebviewMessage(
	input: unknown,
): ArtifactCsvSaveParseResult<ArtifactCsvSaveWebviewMessage> {
	const admission = admitArtifactCsvSaveWebviewMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown artifact CSV save request type.');
}

export function parseArtifactCsvSaveHostMessage(
	input: unknown,
): ArtifactCsvSaveParseResult<ArtifactCsvSaveHostMessage> {
	const admission = admitArtifactCsvSaveHostMessage(input);
	return admission.recognized
		? admission.parsed
		: failure('Unknown artifact CSV save delivery type.');
}