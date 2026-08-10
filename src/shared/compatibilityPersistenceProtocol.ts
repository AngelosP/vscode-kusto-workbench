export const COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION = 1 as const;
export const COMPATIBILITY_PERSISTENCE_CHANNEL = 'compatibility-persistence' as const;

type UnknownRecord = Record<string, unknown>;

export type CompatibilityPersistenceParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export interface CompatibilityPersistenceEnvelope {
	readonly protocolVersion: typeof COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION;
	readonly channel: typeof COMPATIBILITY_PERSISTENCE_CHANNEL;
	readonly viewSessionId: string;
}

export interface CompatibilityPersistenceState extends UnknownRecord {
	readonly sections: readonly UnknownRecord[];
}

export type CompatibilityPersistenceDocumentKind = 'kql' | 'sql';

export type CompatibilityPersistenceRequestDocument = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'requestDocument';
	requestId: string;
}>;

export type CompatibilityPersistencePersistSnapshot = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'persistDocument';
	state: CompatibilityPersistenceState;
	sourceGeneration: number;
	editRevision: number;
	snapshotId: string;
	flush?: boolean;
	reason?: string;
	flushRequestId?: string;
	testOnlyNoop?: boolean;
}>;

export type CompatibilityPersistenceUnavailableFinalPersist = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'persistDocument';
	state: CompatibilityPersistenceState;
	sourceGeneration: number;
	flushRequestId: string;
	flushUnavailableReason: string;
}>;

export type CompatibilityPersistenceDocumentReloadResult = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'documentReloadResult';
	requestId: string;
	applied: boolean;
	editRevision: number;
	markdownCommandBarrierSupported?: boolean;
}>;

export type CompatibilityPersistenceWebviewMessage =
	| CompatibilityPersistenceRequestDocument
	| CompatibilityPersistencePersistSnapshot
	| CompatibilityPersistenceUnavailableFinalPersist
	| CompatibilityPersistenceDocumentReloadResult;

export type CompatibilityPersistenceWebviewMessageInput =
	| Omit<CompatibilityPersistenceRequestDocument, keyof CompatibilityPersistenceEnvelope>
	| Omit<CompatibilityPersistencePersistSnapshot, keyof CompatibilityPersistenceEnvelope>
	| Omit<CompatibilityPersistenceUnavailableFinalPersist, keyof CompatibilityPersistenceEnvelope>
	| Omit<CompatibilityPersistenceDocumentReloadResult, keyof CompatibilityPersistenceEnvelope>;

interface CompatibilityPersistenceDocumentDataBase extends CompatibilityPersistenceEnvelope, UnknownRecord {
	readonly type: 'documentData';
	readonly ok: boolean;
	readonly requestId: string;
	readonly requestSource: 'webview' | 'host';
	readonly reloadRequestId: string;
	readonly sourceGeneration: number;
	readonly forceReload: boolean;
	readonly documentUri: string;
	readonly documentKind: 'kql' | 'sql';
	readonly allowedSectionKinds: readonly string[];
	readonly firstSectionPinned: boolean;
	readonly documentMutationAllowed: boolean;
}

export interface CompatibilityPersistenceDocumentDataSuccess extends CompatibilityPersistenceDocumentDataBase {
	readonly ok: true;
	readonly editRevision: number;
	readonly expectedEditRevision?: number;
	readonly state: CompatibilityPersistenceState;
	readonly compatibilityMode: boolean;
	readonly compatibilitySingleKind: 'query' | 'sql';
	readonly defaultSectionKind: string;
	readonly upgradeRequestType: 'requestUpgradeToKqlx' | 'requestUpgradeToSqlx';
	readonly compatibilityTooltip: string;
	readonly suppressPersistenceForTest?: boolean;
	readonly htmlPowerBiCompatibilityCheckEnabled?: boolean;
}

export interface CompatibilityPersistenceDocumentDataFailure extends CompatibilityPersistenceDocumentDataBase {
	readonly ok: false;
	readonly error: string;
}

export type CompatibilityPersistenceDocumentData =
	| (CompatibilityPersistenceDocumentDataSuccess & Readonly<{ type: 'documentData' }>)
	| (CompatibilityPersistenceDocumentDataFailure & Readonly<{ type: 'documentData' }>);

export type CompatibilityPersistenceRequestFinalPersist = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'requestFinalPersist';
	requestId: string;
	reason: string;
}>;

export type CompatibilityPersistencePersistDocumentAck = CompatibilityPersistenceEnvelope & Readonly<{
	type: 'persistDocumentAck';
	snapshotId: string;
	editRevision: number;
	orderedSectionIds?: readonly string[];
}>;

export type CompatibilityPersistenceHostMessage =
	| CompatibilityPersistenceDocumentData
	| CompatibilityPersistenceRequestFinalPersist
	| CompatibilityPersistencePersistDocumentAck;

const webviewMessageTypes = new Set([
	'requestDocument',
	'persistDocument',
	'documentReloadResult',
]);

const hostMessageTypes = new Set([
	'documentData',
	'requestFinalPersist',
	'persistDocumentAck',
]);

function failure<T>(error: string): CompatibilityPersistenceParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

function isRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateOptionalBoolean(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && typeof input[key] !== 'boolean'
		? `${key} must be a boolean when present.`
		: undefined;
}

function validateOptionalRevision(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && !isRevision(input[key])
		? `${key} must be a non-negative safe integer when present.`
		: undefined;
}

function validateOptionalNonEmptyString(input: UnknownRecord, key: string): string | undefined {
	return input[key] !== undefined && !nonEmptyString(input[key])
		? `${key} must be a non-empty string when present.`
		: undefined;
}

function parseEnvelope(input: UnknownRecord): string | undefined {
	if (input.protocolVersion !== COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION) {
		return `Compatibility persistence protocol version must be ${COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION}.`;
	}
	if (input.channel !== COMPATIBILITY_PERSISTENCE_CHANNEL) {
		return `Compatibility persistence channel must be "${COMPATIBILITY_PERSISTENCE_CHANNEL}".`;
	}
	if (!nonEmptyString(input.viewSessionId)) {
		return 'Compatibility persistence session ID must be a non-empty string.';
	}
	return undefined;
}

function parseState(
	input: unknown,
	documentKind?: CompatibilityPersistenceDocumentKind,
	requirePrimary = false,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceState> {
	if (!isRecord(input) || !Array.isArray(input.sections)) {
		return failure('Compatibility persistence state must contain a section array.');
	}
	const ids = new Set<string>();
	for (const section of input.sections) {
		if (!isRecord(section)) return failure('Every compatibility persistence section must be an object.');
		const id = nonEmptyString(section.id);
		if (!id) return failure('Every compatibility persistence section must have a non-empty ID.');
		if (ids.has(id)) return failure(`Duplicate compatibility persistence section ID "${id}".`);
		ids.add(id);
		if (!nonEmptyString(section.type)) {
			return failure(`Compatibility persistence section "${id}" must have a non-empty type.`);
		}
	}
	if (requirePrimary && documentKind) {
		const primary = input.sections[0];
		const expectedType = documentKind === 'kql' ? 'query' : 'sql';
		if (!primary || primary.type !== expectedType) {
			return failure(`The ${documentKind.toUpperCase()} compatibility primary section is pinned and cannot be removed or replaced.`);
		}
		if (typeof primary.query !== 'string') {
			return failure(`The ${documentKind.toUpperCase()} compatibility primary query must be a string.`);
		}
	}
	return { ok: true, value: input as CompatibilityPersistenceState };
}

function parseStringArray(input: unknown, label: string): CompatibilityPersistenceParseResult<readonly string[]> {
	if (!Array.isArray(input) || input.some(value => typeof value !== 'string')) {
		return failure(`${label} must be an array of strings.`);
	}
	return { ok: true, value: input };
}

export function isCompatibilityPersistenceWebviewMessageType(input: unknown): boolean {
	return isRecord(input) && webviewMessageTypes.has(String(input.type ?? ''));
}

export function isCompatibilityPersistenceHostMessageType(input: unknown): boolean {
	return isRecord(input) && hostMessageTypes.has(String(input.type ?? ''));
}

export function parseCompatibilityPersistenceEnvelope(
	input: unknown,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceEnvelope> {
	if (!isRecord(input)) return failure('Compatibility persistence envelope must be an object.');
	const error = parseEnvelope(input);
	if (error) return failure(error);
	return { ok: true, value: input as unknown as CompatibilityPersistenceEnvelope };
}

export function parseCompatibilityPersistenceWebviewMessage(
	input: unknown,
	documentKind?: CompatibilityPersistenceDocumentKind,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceWebviewMessage> {
	if (!isRecord(input)) return failure('Compatibility persistence webview message must be an object.');
	const envelopeError = parseEnvelope(input);
	if (envelopeError) return failure(envelopeError);

	if (input.type === 'requestDocument') {
		if (!nonEmptyString(input.requestId)) return failure('Document request ID must be a non-empty string.');
		return { ok: true, value: input as unknown as CompatibilityPersistenceRequestDocument };
	}
	if (input.type === 'documentReloadResult') {
		if (!nonEmptyString(input.requestId)) return failure('Reload result request ID must be a non-empty string.');
		if (typeof input.applied !== 'boolean') return failure('Reload result applied must be a boolean.');
		if (!isRevision(input.editRevision)) return failure('Reload result editRevision must be a non-negative safe integer.');
		const barrierError = validateOptionalBoolean(input, 'markdownCommandBarrierSupported');
		if (barrierError) return failure(barrierError);
		return { ok: true, value: input as unknown as CompatibilityPersistenceDocumentReloadResult };
	}
	if (input.type === 'persistDocument') {
		const unavailableFinal = input.flushUnavailableReason !== undefined;
		const state = parseState(input.state, documentKind, !unavailableFinal);
		if (!state.ok) return state;
		if (!isRevision(input.sourceGeneration)) {
			return failure('Persist sourceGeneration must be a non-negative safe integer.');
		}
		if (unavailableFinal) {
			if (!nonEmptyString(input.flushRequestId)) {
				return failure('Unavailable final persist must contain a non-empty flushRequestId.');
			}
			if (!nonEmptyString(input.flushUnavailableReason)) {
				return failure('Unavailable final persist must contain a non-empty reason.');
			}
			if (input.snapshotId !== undefined || input.editRevision !== undefined) {
				return failure('Unavailable final persist cannot contain snapshot identity or revision.');
			}
			return { ok: true, value: input as unknown as CompatibilityPersistenceUnavailableFinalPersist };
		}
		if (!isRevision(input.editRevision)) {
			return failure('Persist editRevision must be a non-negative safe integer.');
		}
		if (!nonEmptyString(input.snapshotId)) return failure('Persist snapshotId must be a non-empty string.');
		for (const key of ['flushRequestId'] as const) {
			const error = validateOptionalNonEmptyString(input, key);
			if (error) return failure(error);
		}
		for (const key of ['flush', 'testOnlyNoop'] as const) {
			const error = validateOptionalBoolean(input, key);
			if (error) return failure(error);
		}
		if (input.reason !== undefined && typeof input.reason !== 'string') {
			return failure('Persist reason must be a string when present.');
		}
		return { ok: true, value: input as unknown as CompatibilityPersistencePersistSnapshot };
	}
	return failure('Unknown compatibility persistence webview message type.');
}

export function parseCompatibilityPersistenceHostMessage(
	input: unknown,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceHostMessage> {
	if (!isRecord(input)) return failure('Compatibility persistence host message must be an object.');
	const envelopeError = parseEnvelope(input);
	if (envelopeError) return failure(envelopeError);

	if (input.type === 'requestFinalPersist') {
		if (!nonEmptyString(input.requestId)) return failure('Final persist request ID must be a non-empty string.');
		if (!nonEmptyString(input.reason)) return failure('Final persist reason must be a non-empty string.');
		return { ok: true, value: input as unknown as CompatibilityPersistenceRequestFinalPersist };
	}
	if (input.type === 'persistDocumentAck') {
		if (!nonEmptyString(input.snapshotId)) return failure('Persist acknowledgement snapshotId must be a non-empty string.');
		if (!isRevision(input.editRevision)) {
			return failure('Persist acknowledgement editRevision must be a non-negative safe integer.');
		}
		if (input.orderedSectionIds !== undefined) {
			const order = parseStringArray(input.orderedSectionIds, 'Persist acknowledgement orderedSectionIds');
			if (!order.ok) return order;
		}
		return { ok: true, value: input as unknown as CompatibilityPersistencePersistDocumentAck };
	}
	if (input.type === 'documentData') {
		if (typeof input.ok !== 'boolean') return failure('documentData.ok must be a boolean.');
		if (!nonEmptyString(input.requestId)) return failure('documentData.requestId must be a non-empty string.');
		if (input.requestSource !== 'webview' && input.requestSource !== 'host') {
			return failure('documentData.requestSource must be "webview" or "host".');
		}
		if (!nonEmptyString(input.reloadRequestId)) return failure('documentData.reloadRequestId must be a non-empty string.');
		if (!isRevision(input.sourceGeneration)) {
			return failure('documentData.sourceGeneration must be a non-negative safe integer.');
		}
		if (typeof input.forceReload !== 'boolean') return failure('documentData.forceReload must be a boolean.');
		if (typeof input.documentUri !== 'string') return failure('documentData.documentUri must be a string.');
		if (input.documentKind !== 'kql' && input.documentKind !== 'sql') {
			return failure('documentData.documentKind must be "kql" or "sql".');
		}
		const allowed = parseStringArray(input.allowedSectionKinds, 'documentData.allowedSectionKinds');
		if (!allowed.ok) return allowed;
		for (const key of ['firstSectionPinned', 'documentMutationAllowed'] as const) {
			if (typeof input[key] !== 'boolean') return failure(`documentData.${key} must be a boolean.`);
		}
		if (!input.ok) {
			if (!nonEmptyString(input.error)) return failure('Failed documentData.error must be a non-empty string.');
			return { ok: true, value: input as unknown as CompatibilityPersistenceDocumentDataFailure };
		}
		const state = parseState(input.state, input.documentKind, true);
		if (!state.ok) return state;
		if (!isRevision(input.editRevision)) {
			return failure('documentData.editRevision must be a non-negative safe integer.');
		}
		const expectedRevisionError = validateOptionalRevision(input, 'expectedEditRevision');
		if (expectedRevisionError) return failure(expectedRevisionError);
		for (const key of ['compatibilityMode', 'suppressPersistenceForTest', 'htmlPowerBiCompatibilityCheckEnabled'] as const) {
			const error = key === 'compatibilityMode'
				? (typeof input[key] !== 'boolean' ? `documentData.${key} must be a boolean.` : undefined)
				: validateOptionalBoolean(input, key);
			if (error) return failure(error);
		}
		if (input.compatibilitySingleKind !== 'query' && input.compatibilitySingleKind !== 'sql') {
			return failure('documentData.compatibilitySingleKind must be "query" or "sql".');
		}
		if (!nonEmptyString(input.defaultSectionKind)) {
			return failure('documentData.defaultSectionKind must be a non-empty string.');
		}
		if (input.upgradeRequestType !== 'requestUpgradeToKqlx' && input.upgradeRequestType !== 'requestUpgradeToSqlx') {
			return failure('documentData.upgradeRequestType must be a compatibility upgrade request type.');
		}
		if (typeof input.compatibilityTooltip !== 'string') {
			return failure('documentData.compatibilityTooltip must be a string.');
		}
		return { ok: true, value: input as unknown as CompatibilityPersistenceDocumentDataSuccess };
	}
	return failure('Unknown compatibility persistence host message type.');
}

export function stampCompatibilityPersistenceWebviewMessage(
	viewSessionId: string,
	input: CompatibilityPersistenceWebviewMessageInput,
	documentKind?: CompatibilityPersistenceDocumentKind,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceWebviewMessage> {
	return parseCompatibilityPersistenceWebviewMessage({
		...input,
		protocolVersion: COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
		channel: COMPATIBILITY_PERSISTENCE_CHANNEL,
		viewSessionId,
	}, documentKind);
}

export function stampCompatibilityPersistenceHostMessage(
	viewSessionId: string,
	input: unknown,
): CompatibilityPersistenceParseResult<CompatibilityPersistenceHostMessage> {
	if (!isRecord(input)) return failure('Compatibility persistence host message must be an object.');
	return parseCompatibilityPersistenceHostMessage({
		...input,
		protocolVersion: COMPATIBILITY_PERSISTENCE_PROTOCOL_VERSION,
		channel: COMPATIBILITY_PERSISTENCE_CHANNEL,
		viewSessionId,
	});
}