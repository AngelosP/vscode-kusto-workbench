import {
	parseChartSection,
	type ChartSectionState,
} from './chartSectionDefinition';
import {
	isMarkdownDocumentOwnedSectionKind,
	type MarkdownDocumentCommand,
	type MarkdownDocumentProjection,
} from './markdownDocumentAggregate';
import {
	parseMarkdownSection,
	type MarkdownSectionState,
} from './markdownSectionDefinition';
import {
	parsePythonSection,
	type PythonSectionState,
} from './pythonSectionDefinition';
import {
	parseUrlSection,
	type UrlSectionState,
} from './urlSectionDefinition';

export const DOCUMENT_VIEW_PROTOCOL_VERSION = 1 as const;
export const DOCUMENT_VIEW_CHANNEL = 'document-view' as const;

type UnknownRecord = Record<string, unknown>;

export type DocumentViewParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

export interface DocumentViewEnvelope {
	readonly protocolVersion: typeof DOCUMENT_VIEW_PROTOCOL_VERSION;
	readonly channel: typeof DOCUMENT_VIEW_CHANNEL;
	readonly viewSessionId: string;
}

export interface DocumentViewState extends UnknownRecord {
	readonly sections: readonly UnknownRecord[];
}

export interface DocumentViewDocumentDataSuccess extends DocumentViewEnvelope, UnknownRecord {
	readonly type: 'documentData';
	readonly ok: true;
	readonly reloadRequestId: string;
	readonly sourceGeneration: number;
	readonly forceReload: boolean;
	readonly documentUri: string;
	readonly state: DocumentViewState;
	readonly documentRevision: number;
	readonly sectionRevisions: Readonly<Record<string, number>>;
	readonly markdownSectionRevisions: Readonly<Record<string, number>>;
}

export interface DocumentViewDocumentDataFailure extends DocumentViewEnvelope, UnknownRecord {
	readonly type: 'documentData';
	readonly ok: false;
	readonly reloadRequestId: string;
	readonly sourceGeneration: number;
	readonly forceReload: boolean;
	readonly documentUri: string;
	readonly error: string;
}

export type DocumentViewDocumentData = DocumentViewDocumentDataSuccess | DocumentViewDocumentDataFailure;

export type DocumentViewMarkdownCommandResult = DocumentViewEnvelope & Readonly<{
	type: 'markdownDocumentCommandResult';
	commandId: string;
	ok: boolean;
	sourceGeneration: number;
	documentRevision: number;
	sectionRevision?: number;
	error?: Readonly<{ code: string; message: string }>;
	projection?: MarkdownDocumentProjection;
}>;

export type DocumentViewMarkdownBarrierRequest = DocumentViewEnvelope & Readonly<{
	type: 'requestMarkdownCommandBarrier';
	requestId: string;
	sourceGeneration: number;
}>;

export type DocumentViewHostMessage =
	| DocumentViewDocumentData
	| DocumentViewMarkdownCommandResult
	| DocumentViewMarkdownBarrierRequest;

export type DocumentViewReloadResult = DocumentViewEnvelope & Readonly<{
	type: 'documentReloadResult';
	requestId: string;
	applied: boolean;
	editRevision: number;
	markdownCommandBarrierSupported?: boolean;
}>;

export type DocumentViewMarkdownCommand = DocumentViewEnvelope & Readonly<{
	type: 'markdownDocumentCommand';
	commandId: string;
	sourceGeneration: number;
	expectedDocumentRevision: number;
	command: MarkdownDocumentCommand;
}>;

export type DocumentViewMarkdownBarrierResult = DocumentViewEnvelope & Readonly<{
	type: 'markdownDocumentCommandBarrierResult';
	requestId: string;
	sourceGeneration: number;
	documentRevision: number;
	accepted: boolean;
}>;

export type DocumentViewWebviewMessage =
	| DocumentViewReloadResult
	| DocumentViewMarkdownCommand
	| DocumentViewMarkdownBarrierResult;

export type DocumentViewWebviewMessageInput =
	| Omit<DocumentViewReloadResult, keyof DocumentViewEnvelope>
	| Omit<DocumentViewMarkdownCommand, keyof DocumentViewEnvelope>
	| Omit<DocumentViewMarkdownBarrierResult, keyof DocumentViewEnvelope>;

const hostMessageTypes = new Set([
	'documentData',
	'markdownDocumentCommandResult',
	'requestMarkdownCommandBarrier',
]);
const webviewMessageTypes = new Set([
	'documentReloadResult',
	'markdownDocumentCommand',
	'markdownDocumentCommandBarrierResult',
]);

function failure<T>(error: string): DocumentViewParseResult<T> {
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

function parseEnvelope(input: UnknownRecord): string | undefined {
	if (input.protocolVersion !== DOCUMENT_VIEW_PROTOCOL_VERSION) {
		return `Document-view protocol version must be ${DOCUMENT_VIEW_PROTOCOL_VERSION}.`;
	}
	if (input.channel !== DOCUMENT_VIEW_CHANNEL) {
		return `Document-view channel must be "${DOCUMENT_VIEW_CHANNEL}".`;
	}
	if (!nonEmptyString(input.viewSessionId)) return 'Document-view session ID must be a non-empty string.';
	return undefined;
}

function parseRevisionRecord(
	input: unknown,
	expectedIds: readonly string[],
	label: string,
): DocumentViewParseResult<Readonly<Record<string, number>>> {
	if (!isRecord(input)) return failure(`${label} must be an object.`);
	const expected = new Set(expectedIds);
	const keys = Object.keys(input);
	if (keys.length !== expected.size || keys.some(key => !expected.has(key))) {
		return failure(`${label} must contain exactly the projected host-owned section IDs.`);
	}
	const result: Record<string, number> = Object.create(null) as Record<string, number>;
	for (const id of expectedIds) {
		if (!isRevision(input[id])) return failure(`${label}.${id} must be a non-negative safe integer.`);
		result[id] = Number(input[id]);
	}
	return { ok: true, value: result };
}

function parseOwnedSection(
	input: unknown,
): DocumentViewParseResult<ChartSectionState | MarkdownSectionState | PythonSectionState | UrlSectionState> {
	if (!isRecord(input)) return failure('Host-owned section must be an object.');
	if (input.type === 'chart') return parseChartSection(input);
	if (input.type === 'markdown') return parseMarkdownSection(input);
	if (input.type === 'python') return parsePythonSection(input);
	if (input.type === 'url') return parseUrlSection(input);
	return failure('Host-owned section type is invalid.');
}

function validateDocumentState(input: unknown): DocumentViewParseResult<{
	state: DocumentViewState;
	ownedIds: string[];
	markdownIds: string[];
}> {
	if (!isRecord(input) || !Array.isArray(input.sections)) {
		return failure('Document-view state must contain a section array.');
	}
	const ids = new Set<string>();
	const ownedIds: string[] = [];
	const markdownIds: string[] = [];
	for (const section of input.sections) {
		if (!isRecord(section)) return failure('Every projected document section must be an object.');
		const id = nonEmptyString(section.id);
		if (!id) return failure('Every projected document section must have a non-empty ID.');
		if (ids.has(id)) return failure(`Duplicate projected document section ID "${id}".`);
		ids.add(id);
		if (!isMarkdownDocumentOwnedSectionKind(section.type)) continue;
		const parsed = parseOwnedSection(section);
		if (!parsed.ok) return parsed;
		ownedIds.push(id);
		if (parsed.value.type === 'markdown') markdownIds.push(id);
	}
	return {
		ok: true,
		value: { state: input as DocumentViewState, ownedIds, markdownIds },
	};
}

export function parseDocumentViewProjection(input: unknown): DocumentViewParseResult<MarkdownDocumentProjection> {
	if (!isRecord(input)) return failure('Document-view projection must be an object.');
	if (!isRevision(input.documentRevision)) {
		return failure('Document-view projection revision must be a non-negative safe integer.');
	}
	const chartInput = input.chartSections ?? [];
	const pythonInput = input.pythonSections ?? [];
	if (!Array.isArray(chartInput)
		|| !Array.isArray(input.markdownSections)
		|| !Array.isArray(pythonInput)
		|| !Array.isArray(input.urlSections)
		|| !Array.isArray(input.orderedSectionIds)) {
		return failure('Document-view projection section collections must be arrays.');
	}
	const chartSections: ChartSectionState[] = [];
	for (const section of chartInput) {
		const parsed = parseChartSection(section);
		if (!parsed.ok) return parsed;
		chartSections.push(parsed.value);
	}
	const markdownSections: MarkdownSectionState[] = [];
	for (const section of input.markdownSections) {
		const parsed = parseMarkdownSection(section);
		if (!parsed.ok) return parsed;
		markdownSections.push(parsed.value);
	}
	const pythonSections: PythonSectionState[] = [];
	for (const section of pythonInput) {
		const parsed = parsePythonSection(section);
		if (!parsed.ok) return parsed;
		pythonSections.push(parsed.value);
	}
	const urlSections: UrlSectionState[] = [];
	for (const section of input.urlSections) {
		const parsed = parseUrlSection(section);
		if (!parsed.ok) return parsed;
		urlSections.push(parsed.value);
	}
	const ownedIds = [
		...chartSections.map(section => section.id),
		...markdownSections.map(section => section.id),
		...pythonSections.map(section => section.id),
		...urlSections.map(section => section.id),
	];
	if (new Set(ownedIds).size !== ownedIds.length) {
		return failure('Document-view projection host-owned section IDs must be unique.');
	}
	const orderedSectionIds = input.orderedSectionIds.map(nonEmptyString);
	if (orderedSectionIds.some(id => !id)) {
		return failure('Document-view projection order must contain non-empty section IDs.');
	}
	const normalizedOrder = orderedSectionIds as string[];
	const orderSet = new Set(normalizedOrder);
	if (orderSet.size !== normalizedOrder.length || ownedIds.some(id => !orderSet.has(id))) {
		return failure('Document-view projection order must uniquely contain every host-owned section ID.');
	}
	const sectionRevisions = parseRevisionRecord(input.sectionRevisions, ownedIds, 'sectionRevisions');
	if (!sectionRevisions.ok) return sectionRevisions;
	const markdownSectionRevisions = parseRevisionRecord(
		input.markdownSectionRevisions,
		markdownSections.map(section => section.id),
		'markdownSectionRevisions',
	);
	if (!markdownSectionRevisions.ok) return markdownSectionRevisions;
	return {
		ok: true,
		value: {
			documentRevision: Number(input.documentRevision),
			sectionRevisions: sectionRevisions.value,
			markdownSectionRevisions: markdownSectionRevisions.value,
			chartSections,
			markdownSections,
			pythonSections,
			urlSections,
			orderedSectionIds: normalizedOrder,
		},
	};
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

function parseDocumentData(input: UnknownRecord): DocumentViewParseResult<DocumentViewDocumentData> {
	if (typeof input.ok !== 'boolean') return failure('documentData.ok must be a boolean.');
	if (!nonEmptyString(input.reloadRequestId)) return failure('documentData.reloadRequestId must be a non-empty string.');
	if (!isRevision(input.sourceGeneration)) return failure('documentData.sourceGeneration must be a non-negative safe integer.');
	if (typeof input.forceReload !== 'boolean') return failure('documentData.forceReload must be a boolean.');
	if (typeof input.documentUri !== 'string') return failure('documentData.documentUri must be a string.');
	for (const key of ['suppressPersistenceForTest', 'htmlPowerBiCompatibilityCheckEnabled']) {
		const error = validateOptionalBoolean(input, key);
		if (error) return failure(error);
	}
	for (const key of ['expectedEditRevision', 'editRevision']) {
		const error = validateOptionalRevision(input, key);
		if (error) return failure(error);
	}
	if (!input.ok) {
		if (!nonEmptyString(input.error)) return failure('Failed documentData.error must be a non-empty string.');
		return { ok: true, value: input as unknown as DocumentViewDocumentDataFailure };
	}
	const state = validateDocumentState(input.state);
	if (!state.ok) return state;
	if (!isRevision(input.documentRevision)) {
		return failure('documentData.documentRevision must be a non-negative safe integer.');
	}
	const sectionRevisions = parseRevisionRecord(input.sectionRevisions, state.value.ownedIds, 'sectionRevisions');
	if (!sectionRevisions.ok) return sectionRevisions;
	const markdownSectionRevisions = parseRevisionRecord(
		input.markdownSectionRevisions,
		state.value.markdownIds,
		'markdownSectionRevisions',
	);
	if (!markdownSectionRevisions.ok) return markdownSectionRevisions;
	return { ok: true, value: input as unknown as DocumentViewDocumentDataSuccess };
}

function parseCommand(input: unknown): DocumentViewParseResult<MarkdownDocumentCommand> {
	if (!isRecord(input)) return failure('Markdown document command must be an object.');
	if (input.type === 'add') {
		const section = parseOwnedSection(input.section);
		if (!section.ok) return section;
		if (input.afterSectionId !== undefined && !nonEmptyString(input.afterSectionId)) {
			return failure('Add command afterSectionId must be a non-empty string when present.');
		}
		return { ok: true, value: input as unknown as MarkdownDocumentCommand };
	}
	if (input.type === 'patch') {
		if (!nonEmptyString(input.sectionId)) return failure('Patch command sectionId must be a non-empty string.');
		if (!isRevision(input.expectedSectionRevision)) {
			return failure('Patch command expectedSectionRevision must be a non-negative safe integer.');
		}
		if (!isRecord(input.patch)) return failure('Patch command patch must be an object.');
		return { ok: true, value: input as unknown as MarkdownDocumentCommand };
	}
	if (input.type === 'remove') {
		if (!nonEmptyString(input.sectionId)) return failure('Remove command sectionId must be a non-empty string.');
		if (!isRevision(input.expectedSectionRevision)) {
			return failure('Remove command expectedSectionRevision must be a non-negative safe integer.');
		}
		return { ok: true, value: input as unknown as MarkdownDocumentCommand };
	}
	return failure('Markdown document command type is invalid.');
}

function parseCommandResult(input: UnknownRecord): DocumentViewParseResult<DocumentViewMarkdownCommandResult> {
	if (!nonEmptyString(input.commandId)) return failure('Command result commandId must be a non-empty string.');
	if (typeof input.ok !== 'boolean') return failure('Command result ok must be a boolean.');
	if (!isRevision(input.sourceGeneration)) return failure('Command result sourceGeneration must be a non-negative safe integer.');
	if (!isRevision(input.documentRevision)) return failure('Command result documentRevision must be a non-negative safe integer.');
	if (input.sectionRevision !== undefined && !isRevision(input.sectionRevision)) {
		return failure('Command result sectionRevision must be a non-negative safe integer when present.');
	}
	if (input.projection !== undefined) {
		const projection = parseDocumentViewProjection(input.projection);
		if (!projection.ok) return projection;
		if (projection.value.documentRevision !== Number(input.documentRevision)) {
			return failure('Command result projection revision must match documentRevision.');
		}
	}
	if (input.ok && input.projection === undefined) return failure('Successful command result must contain a projection.');
	if (!input.ok) {
		if (!isRecord(input.error) || !nonEmptyString(input.error.code) || !nonEmptyString(input.error.message)) {
			return failure('Rejected command result must contain a structured error.');
		}
	}
	return { ok: true, value: input as unknown as DocumentViewMarkdownCommandResult };
}

export function isDocumentViewHostMessageType(input: unknown): boolean {
	return isRecord(input) && hostMessageTypes.has(String(input.type ?? ''));
}

export function isDocumentViewWebviewMessageType(input: unknown): boolean {
	return isRecord(input) && webviewMessageTypes.has(String(input.type ?? ''));
}

export function hasDocumentViewEnvelopeFields(input: unknown): boolean {
	return isRecord(input)
		&& (input.protocolVersion !== undefined || input.channel !== undefined || input.viewSessionId !== undefined);
}

export function parseDocumentViewHostMessage(input: unknown): DocumentViewParseResult<DocumentViewHostMessage> {
	if (!isRecord(input)) return failure('Document-view host message must be an object.');
	const envelopeError = parseEnvelope(input);
	if (envelopeError) return failure(envelopeError);
	if (input.type === 'documentData') return parseDocumentData(input);
	if (input.type === 'markdownDocumentCommandResult') return parseCommandResult(input);
	if (input.type === 'requestMarkdownCommandBarrier') {
		if (!nonEmptyString(input.requestId)) return failure('Barrier request ID must be a non-empty string.');
		if (!isRevision(input.sourceGeneration)) return failure('Barrier sourceGeneration must be a non-negative safe integer.');
		return { ok: true, value: input as unknown as DocumentViewMarkdownBarrierRequest };
	}
	return failure('Unknown document-view host message type.');
}

export function parseDocumentViewWebviewMessage(input: unknown): DocumentViewParseResult<DocumentViewWebviewMessage> {
	if (!isRecord(input)) return failure('Document-view webview message must be an object.');
	const envelopeError = parseEnvelope(input);
	if (envelopeError) return failure(envelopeError);
	if (input.type === 'documentReloadResult') {
		if (!nonEmptyString(input.requestId)) return failure('Reload result requestId must be a non-empty string.');
		if (typeof input.applied !== 'boolean') return failure('Reload result applied must be a boolean.');
		if (!isRevision(input.editRevision)) return failure('Reload result editRevision must be a non-negative safe integer.');
		const barrierError = validateOptionalBoolean(input, 'markdownCommandBarrierSupported');
		if (barrierError) return failure(barrierError);
		return { ok: true, value: input as unknown as DocumentViewReloadResult };
	}
	if (input.type === 'markdownDocumentCommand') {
		if (!nonEmptyString(input.commandId)) return failure('Markdown commandId must be a non-empty string.');
		if (!isRevision(input.sourceGeneration)) return failure('Markdown command sourceGeneration must be a non-negative safe integer.');
		if (!isRevision(input.expectedDocumentRevision)) {
			return failure('Markdown command expectedDocumentRevision must be a non-negative safe integer.');
		}
		const command = parseCommand(input.command);
		if (!command.ok) return command;
		return { ok: true, value: input as unknown as DocumentViewMarkdownCommand };
	}
	if (input.type === 'markdownDocumentCommandBarrierResult') {
		if (!nonEmptyString(input.requestId)) return failure('Barrier result requestId must be a non-empty string.');
		if (!isRevision(input.sourceGeneration)) return failure('Barrier result sourceGeneration must be a non-negative safe integer.');
		if (!isRevision(input.documentRevision)) return failure('Barrier result documentRevision must be a non-negative safe integer.');
		if (typeof input.accepted !== 'boolean') return failure('Barrier result accepted must be a boolean.');
		return { ok: true, value: input as unknown as DocumentViewMarkdownBarrierResult };
	}
	return failure('Unknown document-view webview message type.');
}

export function stampDocumentViewHostMessage(
	viewSessionId: string,
	input: unknown,
): DocumentViewParseResult<DocumentViewHostMessage> {
	if (!isRecord(input)) return failure('Document-view host message must be an object.');
	return parseDocumentViewHostMessage({
		...input,
		protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
		channel: DOCUMENT_VIEW_CHANNEL,
		viewSessionId,
	});
}

export function stampDocumentViewWebviewMessage(
	viewSessionId: string,
	input: DocumentViewWebviewMessageInput,
): DocumentViewParseResult<DocumentViewWebviewMessage> {
	return parseDocumentViewWebviewMessage({
		...input,
		protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
		channel: DOCUMENT_VIEW_CHANNEL,
		viewSessionId,
	});
}