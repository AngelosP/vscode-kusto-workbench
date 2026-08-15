import {
	getRuntimeMessageEnvelopeDescriptorSnapshot,
	isRuntimeProxy,
	type RuntimeMessageEnvelopeDescriptorSnapshot,
} from './runtimeMessageEnvelope';

type UnknownRecord = Record<string, unknown>;
type DescriptorSnapshot = Readonly<{
	input: object;
	descriptors: PropertyDescriptorMap;
	prototype: object | null;
}>;

export type DevelopmentNoteMutationParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export type DevelopmentNoteMutationAdmissionResult<T> =
	| Readonly<{ recognized: false }>
	| Readonly<{
		recognized: true;
		requestId?: string;
		parsed: DevelopmentNoteMutationParseResult<T>;
	}>;

export type DevelopmentNoteMutationEntry = Readonly<{
	id: string;
	created: string;
	updated: string;
	category: string;
	relatedSectionIds?: readonly string[];
	content: string;
	source: string;
}>;

export type DevelopmentNoteMutationPayload =
	| Readonly<{ action: 'add'; entry: DevelopmentNoteMutationEntry }>
	| Readonly<{ action: 'supersede'; entry: DevelopmentNoteMutationEntry; supersededId: string }>
	| Readonly<{ action: 'remove'; noteId: string }>;

export type DevelopmentNoteMutationHostMessage =
	| Readonly<{ type: 'updateDevNotes'; requestId: string; action: 'add'; entry: DevelopmentNoteMutationEntry }>
	| Readonly<{
		type: 'updateDevNotes';
		requestId: string;
		action: 'supersede';
		entry: DevelopmentNoteMutationEntry;
		supersededId: string;
	}>
	| Readonly<{ type: 'updateDevNotes'; requestId: string; action: 'remove'; noteId: string }>;

export type DevelopmentNoteMutationWebviewMessage = Readonly<{
	type: 'toolResponse';
	requestId: string;
	result: Readonly<{ success: boolean }>;
	error?: string;
}>;

export type DevelopmentNoteMutationWebviewAdmission =
	DevelopmentNoteMutationAdmissionResult<DevelopmentNoteMutationWebviewMessage>;

export type DevelopmentNoteMutationResult = Readonly<{ success: boolean; error?: string }>;

type KnownTypeInspection =
	| Readonly<{ recognized: false }>
	| Readonly<{
		recognized: true;
		type: DevelopmentNoteMutationParseResult<string>;
		snapshot?: DescriptorSnapshot;
	}>;

const hostTypes = new Set(['updateDevNotes']);
const webviewTypes = new Set(['toolResponse']);
const capturedWebviewAdmissions = new WeakMap<object, DevelopmentNoteMutationWebviewAdmission>();

function failure<T>(error: string): DevelopmentNoteMutationParseResult<T> {
	return { ok: false, error };
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function getDescriptor(snapshot: DescriptorSnapshot, key: string): PropertyDescriptor | undefined {
	return Reflect.get(snapshot.descriptors, key) as PropertyDescriptor | undefined;
}

function inspectKnownTypeSnapshot(
	snapshot: DescriptorSnapshot,
	types: ReadonlySet<string>,
): KnownTypeInspection {
	try {
		const ownType = getDescriptor(snapshot, 'type');
		if (ownType) {
			const value = descriptorValue(ownType);
			if (typeof value === 'string' && !types.has(value)) return { recognized: false };
			if (!ownType.enumerable || !Object.prototype.hasOwnProperty.call(ownType, 'value')) {
				return { recognized: true, type: failure('type must be an own enumerable data property.'), snapshot };
			}
			return {
				recognized: true,
				type: typeof value === 'string' ? { ok: true, value } : failure('type must be a string.'),
				snapshot,
			};
		}

		let owner = snapshot.prototype;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) {
				return { recognized: true, type: failure('type prototype inspection was cyclic.'), snapshot };
			}
			seen.add(owner);
			const inherited = Object.getOwnPropertyDescriptor(owner, 'type');
			if (inherited) {
				const value = descriptorValue(inherited);
				return typeof value === 'string' && !types.has(value)
					? { recognized: false }
					: { recognized: true, type: failure('type must be an own enumerable data property.'), snapshot };
			}
			owner = Object.getPrototypeOf(owner);
		}
		return { recognized: false };
	} catch {
		return { recognized: true, type: failure('type could not be inspected.') };
	}
}

function inspectKnownType(input: unknown, types: ReadonlySet<string>): KnownTypeInspection {
	const inputType = typeof input;
	if (!input || (inputType !== 'object' && inputType !== 'function')) return { recognized: false };
	try {
		return inspectKnownTypeSnapshot({
			input: input as object,
			descriptors: Object.getOwnPropertyDescriptors(input),
			prototype: Object.getPrototypeOf(input),
		}, types);
	} catch {
		return { recognized: true, type: failure('message could not be inspected.') };
	}
}

function validateExactRecord(
	snapshot: DescriptorSnapshot,
	requiredKeys: ReadonlySet<string>,
	allowedKeys: ReadonlySet<string>,
	label: string,
): DevelopmentNoteMutationParseResult<DescriptorSnapshot> {
	try {
		if (typeof snapshot.input === 'function' || Array.isArray(snapshot.input)) {
			return failure(`${label} must be an object record.`);
		}
		if (snapshot.prototype !== Object.prototype && snapshot.prototype !== null) {
			return failure(`${label} must use a canonical object prototype.`);
		}
		for (const key of Reflect.ownKeys(snapshot.descriptors)) {
			if (typeof key !== 'string' || !allowedKeys.has(key)) {
				return failure(`${label} must contain only canonical fields.`);
			}
			const descriptor = getDescriptor(snapshot, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return failure(`${key} must be an own enumerable data property.`);
			}
		}
		for (const key of requiredKeys) {
			if (!getDescriptor(snapshot, key)) return failure(`${key} is required.`);
		}
		return { ok: true, value: snapshot };
	} catch {
		return failure(`${label} could not be inspected.`);
	}
}

function snapshotRecord(input: unknown, label: string): DevelopmentNoteMutationParseResult<DescriptorSnapshot> {
	if (!input || (typeof input !== 'object' && typeof input !== 'function')) {
		return failure(`${label} must be an object record.`);
	}
	try {
		return {
			ok: true,
			value: {
				input: input as object,
				descriptors: Object.getOwnPropertyDescriptors(input),
				prototype: Object.getPrototypeOf(input),
			},
		};
	} catch {
		return failure(`${label} could not be inspected.`);
	}
}

function readValue(snapshot: DescriptorSnapshot, key: string): unknown {
	return descriptorValue(getDescriptor(snapshot, key));
}

function readString(
	snapshot: DescriptorSnapshot,
	key: string,
	nonblank = false,
): DevelopmentNoteMutationParseResult<string> {
	const descriptor = getDescriptor(snapshot, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	const value = descriptor.value;
	if (typeof value !== 'string' || (nonblank && !value.trim())) {
		return failure(`${key} must be ${nonblank ? 'a nonblank' : 'a'} string.`);
	}
	return { ok: true, value };
}

function readOptionalString(
	snapshot: DescriptorSnapshot,
	key: string,
): DevelopmentNoteMutationParseResult<string | undefined> {
	const descriptor = getDescriptor(snapshot, key);
	if (!descriptor) return { ok: true, value: undefined };
	if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
		return failure(`${key} must be an own enumerable data property.`);
	}
	return descriptor.value === undefined || typeof descriptor.value === 'string'
		? { ok: true, value: descriptor.value }
		: failure(`${key} must be a string when provided.`);
}

function captureStringArray(input: unknown, label: string): DevelopmentNoteMutationParseResult<readonly string[]> {
	try {
		if (isRuntimeProxy(input)) return failure(`${label} must not be a proxy-backed array.`);
		if (!Array.isArray(input)) return failure(`${label} must be an array.`);
		if (Object.getPrototypeOf(input) !== Array.prototype
			|| Object.getOwnPropertyDescriptor(input, Symbol.iterator)) {
			return failure(`${label} must use the canonical array prototype and iterator.`);
		}
		const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
		if (!Number.isSafeInteger(length) || length < 0) return failure(`${label} must have a valid length.`);
		const captured: string[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(input, index);
			if (!descriptor?.enumerable
				|| !Object.prototype.hasOwnProperty.call(descriptor, 'value')
				|| typeof descriptor.value !== 'string') {
				return failure(`${label} must be dense and contain only string data entries.`);
			}
			captured.push(descriptor.value);
		}
		return { ok: true, value: Object.freeze(captured) };
	} catch {
		return failure(`${label} could not be inspected.`);
	}
}

function parseEntry(input: unknown): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationEntry> {
	const captured = snapshotRecord(input, 'Development-note entry');
	if (!captured.ok) return captured;
	const required = new Set(['id', 'created', 'updated', 'category', 'content', 'source']);
	const record = validateExactRecord(
		captured.value,
		required,
		new Set([...required, 'relatedSectionIds']),
		'Development-note entry',
	);
	if (!record.ok) return record;
	const id = readString(record.value, 'id');
	if (!id.ok) return id;
	const created = readString(record.value, 'created');
	if (!created.ok) return created;
	const updated = readString(record.value, 'updated');
	if (!updated.ok) return updated;
	const category = readString(record.value, 'category');
	if (!category.ok) return category;
	const content = readString(record.value, 'content');
	if (!content.ok) return content;
	const source = readString(record.value, 'source');
	if (!source.ok) return source;
	let relatedSectionIds: readonly string[] | undefined;
	if (getDescriptor(record.value, 'relatedSectionIds')) {
		const related = captureStringArray(readValue(record.value, 'relatedSectionIds'), 'relatedSectionIds');
		if (!related.ok) return related;
		relatedSectionIds = related.value;
	}
	return {
		ok: true,
		value: Object.freeze({
			id: id.value,
			created: created.value,
			updated: updated.value,
			category: category.value,
			...(relatedSectionIds ? { relatedSectionIds } : {}),
			content: content.value,
			source: source.value,
		}),
	};
}

function parseMutationSnapshot(
	snapshot: DescriptorSnapshot,
	baseKeys: readonly string[],
	label: string,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationPayload> {
	const action = readString(snapshot, 'action');
	if (!action.ok) return action;
	if (action.value === 'add') {
		const allowed = new Set([...baseKeys, 'action', 'entry']);
		const record = validateExactRecord(snapshot, allowed, allowed, label);
		if (!record.ok) return record;
		const entryInput = readValue(record.value, 'entry');
		if (entryInput === snapshot.input) return failure('entry must not alias its enclosing mutation.');
		if (isRuntimeProxy(entryInput)) return failure('entry must not be a proxy-backed record.');
		const entry = parseEntry(entryInput);
		return entry.ok ? { ok: true, value: Object.freeze({ action: 'add', entry: entry.value }) } : entry;
	}
	if (action.value === 'supersede') {
		const allowed = new Set([...baseKeys, 'action', 'entry', 'supersededId']);
		const record = validateExactRecord(snapshot, allowed, allowed, label);
		if (!record.ok) return record;
		const entryInput = readValue(record.value, 'entry');
		if (entryInput === snapshot.input) return failure('entry must not alias its enclosing mutation.');
		if (isRuntimeProxy(entryInput)) return failure('entry must not be a proxy-backed record.');
		const entry = parseEntry(entryInput);
		if (!entry.ok) return entry;
		const supersededId = readString(record.value, 'supersededId', true);
		return supersededId.ok
			? { ok: true, value: Object.freeze({ action: 'supersede', entry: entry.value, supersededId: supersededId.value }) }
			: supersededId;
	}
	if (action.value === 'remove') {
		const allowed = new Set([...baseKeys, 'action', 'noteId']);
		const record = validateExactRecord(snapshot, allowed, allowed, label);
		if (!record.ok) return record;
		const noteId = readString(record.value, 'noteId', true);
		return noteId.ok
			? { ok: true, value: Object.freeze({ action: 'remove', noteId: noteId.value }) }
			: noteId;
	}
	return failure('action must be add, supersede, or remove.');
}

function parseHostInspection(
	inspection: Extract<KnownTypeInspection, { recognized: true }>,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationHostMessage> {
	if (!inspection.type.ok) return inspection.type;
	if (!inspection.snapshot) return failure('Development-note mutation request could not be captured.');
	const requestId = readString(inspection.snapshot, 'requestId', true);
	if (!requestId.ok) return requestId;
	const payload = parseMutationSnapshot(
		inspection.snapshot,
		['type', 'requestId'],
		'Development-note mutation request',
	);
	if (!payload.ok) return payload;
	return {
		ok: true,
		value: Object.freeze({ type: 'updateDevNotes', requestId: requestId.value, ...payload.value }),
	};
}

function parseWebviewInspection(
	inspection: Extract<KnownTypeInspection, { recognized: true }>,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationWebviewMessage> {
	if (!inspection.type.ok) return inspection.type;
	if (!inspection.snapshot) return failure('Development-note mutation response could not be captured.');
	const record = validateExactRecord(
		inspection.snapshot,
		new Set(['type', 'requestId', 'result']),
		new Set(['type', 'requestId', 'result', 'error']),
		'Development-note mutation response',
	);
	if (!record.ok) return record;
	const requestId = readString(record.value, 'requestId', true);
	if (!requestId.ok) return requestId;
	const resultInput = readValue(record.value, 'result');
	if (resultInput === inspection.snapshot.input) {
		return failure('result must not alias its enclosing mutation response.');
	}
	if (isRuntimeProxy(resultInput)) return failure('result must not be a proxy-backed record.');
	const resultSnapshot = snapshotRecord(resultInput, 'Development-note mutation result');
	if (!resultSnapshot.ok) return resultSnapshot;
	const resultRecord = validateExactRecord(
		resultSnapshot.value,
		new Set(['success']),
		new Set(['success']),
		'Development-note mutation result',
	);
	if (!resultRecord.ok) return resultRecord;
	const success = readValue(resultRecord.value, 'success');
	if (typeof success !== 'boolean') return failure('success must be a boolean.');
	const error = readOptionalString(record.value, 'error');
	if (!error.ok) return error;
	if (success && error.value !== undefined) return failure('A successful development-note mutation cannot include an error.');
	return {
		ok: true,
		value: Object.freeze({
			type: 'toolResponse',
			requestId: requestId.value,
			result: Object.freeze({ success }),
			...(error.value !== undefined ? { error: error.value } : {}),
		}),
	};
}

function safelyReadRequestId(inspection: KnownTypeInspection): string | undefined {
	if (!inspection.recognized || !inspection.snapshot) return undefined;
	try {
		const ownDescriptor = getDescriptor(inspection.snapshot, 'requestId');
		if (ownDescriptor) {
			const value = descriptorValue(ownDescriptor);
			return typeof value === 'string' && value.trim() ? value : undefined;
		}
		let owner = inspection.snapshot.prototype;
		const seen = new Set<object>();
		let depth = 0;
		while (owner && depth++ < 16) {
			if (seen.has(owner)) return undefined;
			seen.add(owner);
			const inheritedDescriptor = Object.getOwnPropertyDescriptor(owner, 'requestId');
			if (inheritedDescriptor) {
				const value = descriptorValue(inheritedDescriptor);
				return typeof value === 'string' && value.trim() ? value : undefined;
			}
			owner = Object.getPrototypeOf(owner);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function parseDevelopmentNoteMutationPayload(
	input: unknown,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationPayload> {
	const snapshot = snapshotRecord(input, 'Development-note mutation payload');
	return snapshot.ok
		? parseMutationSnapshot(snapshot.value, [], 'Development-note mutation payload')
		: snapshot;
}

export function createDevelopmentNoteMutationHostMessage(
	requestId: string,
	payload: unknown,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationHostMessage> {
	if (typeof requestId !== 'string' || !requestId.trim()) return failure('requestId must be a nonblank string.');
	const parsed = parseDevelopmentNoteMutationPayload(payload);
	return parsed.ok
		? { ok: true, value: Object.freeze({ type: 'updateDevNotes', requestId, ...parsed.value }) }
		: parsed;
}

export function createDevelopmentNoteMutationWebviewMessage(
	requestId: string,
	success: boolean,
	error?: string,
): DevelopmentNoteMutationWebviewMessage {
	return Object.freeze({
		type: 'toolResponse',
		requestId,
		result: Object.freeze({ success }),
		...(!success && error !== undefined ? { error } : {}),
	});
}

export function admitDevelopmentNoteMutationHostMessage(
	input: unknown,
): DevelopmentNoteMutationAdmissionResult<DevelopmentNoteMutationHostMessage> {
	const inspection = inspectKnownType(input, hostTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		requestId: safelyReadRequestId(inspection),
		parsed: parseHostInspection(inspection),
	};
}

export function admitDevelopmentNoteMutationHostMessageFromEnvelope(
	snapshot: RuntimeMessageEnvelopeDescriptorSnapshot,
): DevelopmentNoteMutationAdmissionResult<DevelopmentNoteMutationHostMessage> {
	const inspection = inspectKnownTypeSnapshot({
		input: snapshot.input,
		descriptors: snapshot.descriptors,
		prototype: snapshot.prototype,
	}, hostTypes);
	if (!inspection.recognized) return inspection;
	return {
		recognized: true,
		requestId: safelyReadRequestId(inspection),
		parsed: parseHostInspection(inspection),
	};
}

export function admitDevelopmentNoteMutationWebviewMessage(
	input: unknown,
): DevelopmentNoteMutationWebviewAdmission {
	const envelopeSnapshot = getRuntimeMessageEnvelopeDescriptorSnapshot(input);
	if (envelopeSnapshot && input && (typeof input === 'object' || typeof input === 'function')) {
		const cached = capturedWebviewAdmissions.get(input as object);
		if (cached) return cached;
	}
	const inspection = envelopeSnapshot
		? inspectKnownTypeSnapshot(
			{
				input: envelopeSnapshot.input,
				descriptors: envelopeSnapshot.descriptors,
				prototype: envelopeSnapshot.prototype,
			},
			webviewTypes,
		)
		: inspectKnownType(input, webviewTypes);
	const admission: DevelopmentNoteMutationWebviewAdmission = !inspection.recognized
		? inspection
		: {
		recognized: true,
		requestId: safelyReadRequestId(inspection),
		parsed: Object.freeze(parseWebviewInspection(inspection)),
	};
	const immutableAdmission = Object.freeze(admission);
	if (envelopeSnapshot && input && (typeof input === 'object' || typeof input === 'function')) {
		capturedWebviewAdmissions.set(input as object, immutableAdmission);
	}
	return immutableAdmission;
}

export function parseDevelopmentNoteMutationHostMessage(
	input: unknown,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationHostMessage> {
	const admission = admitDevelopmentNoteMutationHostMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown development-note mutation request type.');
}

export function parseDevelopmentNoteMutationWebviewMessage(
	input: unknown,
): DevelopmentNoteMutationParseResult<DevelopmentNoteMutationWebviewMessage> {
	const admission = admitDevelopmentNoteMutationWebviewMessage(input);
	return admission.recognized ? admission.parsed : failure('Unknown development-note mutation response type.');
}