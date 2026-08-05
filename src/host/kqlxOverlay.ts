import type { PowerBiUpgradeNoticeState } from '../shared/htmlDashboardUpgrade';
import type { PbiPublishInfo } from '../shared/htmlSectionDefinition';
import type {
	PersistedResultArtifactV1,
	ResultArtifactLineage,
	ResultArtifactPolicy,
	ResultArtifactProducer,
	ResultArtifactSourcePolicy,
} from '../shared/resultArtifact';
import type {
	DevNoteEntry,
	KqlxFileKind,
	KqlxFileV1,
	KqlxSectionV1,
	KqlxStateV1,
} from './kqlxFormat';
import {
	canonicalSectionKind as canonicalKnownSectionKind,
	isKnownSectionKind,
	type KnownSectionKind,
} from '../shared/documentSectionCapabilities';

type JsonPrimitiveKind = 'string' | 'number' | 'boolean';
type JsonPrimitiveFieldSchema = Readonly<{ kind: 'primitive'; primitive: JsonPrimitiveKind }>;
type JsonUnknownFieldSchema = Readonly<{ kind: 'unknown' }>;
type JsonIdentityKey = string | Readonly<{ key: string; optional: true }>;
type JsonFieldSchema = JsonPrimitiveFieldSchema | JsonUnknownFieldSchema | JsonObjectFieldSchema | JsonArrayFieldSchema | JsonRecordFieldSchema;
type JsonObjectFieldSchema = Readonly<{
	kind: 'object';
	fields: Readonly<Record<string, JsonFieldSchema>>;
	preserveExtensionsWhenOmitted: boolean;
	identityKeys: readonly JsonIdentityKey[];
	requiredKeys: readonly string[];
}>;
type JsonArrayFieldSchema = Readonly<{
	kind: 'array';
	item: JsonPrimitiveFieldSchema | JsonUnknownFieldSchema | JsonObjectFieldSchema;
	identityKeys: readonly JsonIdentityKey[];
	identityMode: 'stable' | 'renameable';
}>;
type JsonRecordFieldSchema = Readonly<{
	kind: 'record';
	value: JsonPrimitiveFieldSchema | JsonUnknownFieldSchema;
}>;
type CompleteFieldSchema<T extends object> = { readonly [K in keyof T]-?: JsonFieldSchema };
type KnownSection<T extends KnownSectionKind> = Extract<KqlxSectionV1, { type: T }>;

export class KqlxOverlayConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'KqlxOverlayConflictError';
	}
}

const objectField = <T extends object>(
	fields: CompleteFieldSchema<T>,
	preserveExtensionsWhenOmitted = true,
	identityKeys: readonly JsonIdentityKey[] = [],
	requiredKeys: readonly string[] = [],
): JsonObjectFieldSchema => ({ kind: 'object', fields, preserveExtensionsWhenOmitted, identityKeys, requiredKeys });
const openObjectField = (preserveExtensionsWhenOmitted = true): JsonObjectFieldSchema => ({
	kind: 'object',
	fields: {},
	preserveExtensionsWhenOmitted,
	identityKeys: [],
	requiredKeys: [],
});
const stringField = (): JsonPrimitiveFieldSchema => ({ kind: 'primitive', primitive: 'string' });
const numberField = (): JsonPrimitiveFieldSchema => ({ kind: 'primitive', primitive: 'number' });
const booleanField = (): JsonPrimitiveFieldSchema => ({ kind: 'primitive', primitive: 'boolean' });
const unknownField = (): JsonUnknownFieldSchema => ({ kind: 'unknown' });
const arrayField = (
	item: JsonPrimitiveFieldSchema | JsonUnknownFieldSchema | JsonObjectFieldSchema = unknownField(),
	identityKeys: readonly JsonIdentityKey[] = [],
	identityMode: 'stable' | 'renameable' = 'renameable',
): JsonArrayFieldSchema => ({ kind: 'array', item, identityKeys, identityMode });
const recordField = (
	value: JsonPrimitiveFieldSchema | JsonUnknownFieldSchema = unknownField(),
): JsonRecordFieldSchema => ({ kind: 'record', value });

const artifactProducerField = objectField({
	engine: stringField(),
	boxId: stringField(),
	executionId: stringField(),
	sectionInstanceId: stringField(),
	targetGeneration: numberField(),
	reservationSequence: numberField(),
	connectionId: stringField(),
	database: stringField(),
	query: stringField(),
	producer: stringField(),
	dispatch: openObjectField(false),
} satisfies CompleteFieldSchema<ResultArtifactProducer>, false, [], ['boxId']);
const artifactSourcePolicyField = objectField({
	sourceArtifactId: stringField(),
	accountPartition: stringField(),
	authSessionGeneration: numberField(),
	leaveNoTraceRevision: numberField(),
	connectionRevision: numberField(),
	connectionIdentityKey: stringField(),
	exposeToActiveContent: booleanField(),
	sendToModel: booleanField(),
	shareToClipboard: booleanField(),
	exportToCsv: booleanField(),
} satisfies CompleteFieldSchema<ResultArtifactSourcePolicy>, false, [], ['sourceArtifactId']);
const artifactPolicyField = objectField({
	accountPartition: stringField(),
	authSessionGeneration: numberField(),
	leaveNoTraceRevision: numberField(),
	connectionRevision: numberField(),
	connectionIdentityKey: stringField(),
	exposeToActiveContent: booleanField(),
	sendToModel: booleanField(),
	shareToClipboard: booleanField(),
	exportToCsv: booleanField(),
	sourcePolicies: arrayField(artifactSourcePolicyField, ['sourceArtifactId'], 'stable'),
} satisfies CompleteFieldSchema<ResultArtifactPolicy>, false);
const artifactLineageField = objectField({
	sourceArtifactId: stringField(),
	role: stringField(),
} satisfies CompleteFieldSchema<ResultArtifactLineage>, false, [], ['sourceArtifactId']);
const resultArtifactField = objectField({
	version: numberField(),
	artifactId: stringField(),
	sourceBoxId: stringField(),
	revision: numberField(),
	createdAt: numberField(),
	producer: artifactProducerField,
	policy: artifactPolicyField,
	lineage: arrayField(artifactLineageField, ['sourceArtifactId', { key: 'role', optional: true }], 'stable'),
} satisfies CompleteFieldSchema<PersistedResultArtifactV1>, false, ['artifactId'], [
	'version', 'artifactId', 'sourceBoxId', 'revision', 'createdAt',
]);

type QuerySection = KnownSection<'query'>;
const querySectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	expanded: booleanField(),
	resultsVisible: booleanField(),
	favoritesMode: booleanField(),
	clusterUrl: stringField(),
	authorityId: stringField(),
	connectionIdHint: stringField(),
	database: stringField(),
	linkedQueryPath: stringField(),
	query: stringField(),
	comparisonSourceBoxId: stringField(),
	resultJson: stringField(),
	result: unknownField(),
	resultArtifact: resultArtifactField,
	kustoAccountPartition: stringField(),
	kustoLeaveNoTraceRevision: numberField(),
	runMode: stringField(),
	cacheEnabled: booleanField(),
	cacheValue: numberField(),
	cacheUnit: stringField(),
	editorHeightPx: numberField(),
	resultsHeightPx: numberField(),
	copilotChatVisible: booleanField(),
	copilotChatWidthPx: numberField(),
} satisfies CompleteFieldSchema<QuerySection>;
const copilotQuerySectionSchema = {
	...querySectionSchema,
} satisfies CompleteFieldSchema<KnownSection<'copilotQuery'>>;
const markdownSectionSchema = {
	id: stringField(),
	type: stringField(),
	title: stringField(),
	text: stringField(),
	tab: stringField(),
	expanded: booleanField(),
	mode: stringField(),
	editorHeightPx: numberField(),
} satisfies CompleteFieldSchema<KnownSection<'markdown'>>;
const pythonSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	code: stringField(),
	output: stringField(),
	expanded: booleanField(),
	editorHeightPx: numberField(),
} satisfies CompleteFieldSchema<KnownSection<'python'>>;
const urlSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	url: stringField(),
	expanded: booleanField(),
	outputHeightPx: numberField(),
	imageSizeMode: stringField(),
	imageAlign: stringField(),
	imageOverflow: stringField(),
} satisfies CompleteFieldSchema<KnownSection<'url'>>;

type ChartSection = KnownSection<'chart'>;
const xAxisSettingsField = objectField({
	sortDirection: stringField(),
	scaleType: stringField(),
	labelDensity: numberField(),
	showAxisLabel: booleanField(),
	customLabel: stringField(),
	titleGap: numberField(),
} satisfies CompleteFieldSchema<NonNullable<ChartSection['xAxisSettings']>>);
const yAxisSettingsField = objectField({
	showAxisLabel: booleanField(),
	customLabel: stringField(),
	min: stringField(),
	max: stringField(),
	seriesColors: recordField(stringField()),
	titleGap: numberField(),
	sortDirection: stringField(),
} satisfies CompleteFieldSchema<NonNullable<ChartSection['yAxisSettings']>>);
const legendSettingsField = objectField({
	position: stringField(),
	stackMode: stringField(),
	gap: numberField(),
	sortMode: stringField(),
	topN: numberField(),
	title: stringField(),
	showEndLabels: booleanField(),
} satisfies CompleteFieldSchema<NonNullable<ChartSection['legendSettings']>>);
const heatmapSettingsField = objectField({
	visualMapPosition: stringField(),
	visualMapGap: numberField(),
	showCellLabels: booleanField(),
	cellLabelMode: stringField(),
	cellLabelN: numberField(),
} satisfies CompleteFieldSchema<NonNullable<ChartSection['heatmapSettings']>>);
const chartSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	mode: stringField(),
	expanded: booleanField(),
	editorHeightPx: numberField(),
	dataSourceId: stringField(),
	chartType: stringField(),
	xColumn: stringField(),
	yColumns: arrayField(stringField()),
	yColumn: stringField(),
	tooltipColumns: arrayField(stringField()),
	legendColumn: stringField(),
	legendPosition: stringField(),
	stackMode: stringField(),
	labelColumn: stringField(),
	valueColumn: stringField(),
	sourceColumn: stringField(),
	targetColumn: stringField(),
	orient: stringField(),
	sankeyLeftMargin: numberField(),
	showDataLabels: booleanField(),
	labelMode: stringField(),
	labelDensity: numberField(),
	sortColumn: stringField(),
	sortDirection: stringField(),
	xAxisSettings: xAxisSettingsField,
	yAxisSettings: yAxisSettingsField,
	legendSettings: legendSettingsField,
	heatmapSettings: heatmapSettingsField,
	chartTitle: stringField(),
	chartSubtitle: stringField(),
	chartTitleAlign: stringField(),
	validation: unknownField(),
} satisfies CompleteFieldSchema<ChartSection>;

type TransformationSection = KnownSection<'transformation'>;
const aggregationField = objectField({
	name: stringField(),
	column: stringField(),
	function: stringField(),
} satisfies CompleteFieldSchema<NonNullable<TransformationSection['aggregations']>[number]>, true, [], ['function']);
const deriveColumnField = objectField({
	name: stringField(),
	expression: stringField(),
} satisfies CompleteFieldSchema<NonNullable<TransformationSection['deriveColumns']>[number]>, true, [], ['name', 'expression']);
const joinKeyField = objectField({
	left: stringField(),
	right: stringField(),
} satisfies CompleteFieldSchema<NonNullable<TransformationSection['joinKeys']>[number]>, true, [], ['left', 'right']);
const transformationSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	mode: stringField(),
	expanded: booleanField(),
	editorHeightPx: numberField(),
	dataSourceId: stringField(),
	transformationType: stringField(),
	distinctColumn: stringField(),
	groupByColumns: arrayField(stringField()),
	aggregations: arrayField(aggregationField, ['name']),
	deriveColumns: arrayField(deriveColumnField, ['name']),
	deriveColumnName: stringField(),
	deriveExpression: stringField(),
	pivotRowKeyColumn: stringField(),
	pivotColumnKeyColumn: stringField(),
	pivotValueColumn: stringField(),
	pivotAggregation: stringField(),
	pivotMaxColumns: numberField(),
	joinRightDataSourceId: stringField(),
	joinKind: stringField(),
	joinKeys: arrayField(joinKeyField, ['left', 'right']),
	joinOmitDuplicateColumns: booleanField(),
} satisfies CompleteFieldSchema<TransformationSection>;

const pbiPublishInfoField = objectField({
	workspaceId: stringField(),
	workspaceName: stringField(),
	semanticModelId: stringField(),
	reportId: stringField(),
	reportName: stringField(),
	reportUrl: stringField(),
	dataMode: stringField(),
} satisfies CompleteFieldSchema<PbiPublishInfo>, false, [], [
	'workspaceId', 'semanticModelId', 'reportId', 'reportName', 'reportUrl',
]);
const powerBiUpgradeNoticeField = objectField({
	dismissedForSection: booleanField(),
	dismissedForVersion: numberField(),
	dismissedForSignature: stringField(),
	dismissedAt: stringField(),
} satisfies CompleteFieldSchema<PowerBiUpgradeNoticeState>);
const htmlSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	code: stringField(),
	mode: stringField(),
	expanded: booleanField(),
	editorHeightPx: numberField(),
	previewHeightPx: numberField(),
	previewHeightUserSet: booleanField(),
	dataSourceIds: arrayField(stringField()),
	pbiPublishInfo: pbiPublishInfoField,
	powerBiUpgradeNotice: powerBiUpgradeNoticeField,
} satisfies CompleteFieldSchema<KnownSection<'html'>>;
const sqlSectionSchema = {
	id: stringField(),
	type: stringField(),
	name: stringField(),
	query: stringField(),
	linkedQueryPath: stringField(),
	comparisonSourceBoxId: stringField(),
	serverUrl: stringField(),
	connectionIdHint: stringField(),
	targetSignature: stringField(),
	principalFingerprint: stringField(),
	revocationGeneration: numberField(),
	database: stringField(),
	expanded: booleanField(),
	resultsVisible: booleanField(),
	favoritesMode: booleanField(),
	resultJson: stringField(),
	result: unknownField(),
	resultArtifact: resultArtifactField,
	runMode: stringField(),
	editorHeightPx: numberField(),
	resultsHeightPx: numberField(),
	copilotChatVisible: booleanField(),
	copilotChatWidthPx: numberField(),
} satisfies CompleteFieldSchema<KnownSection<'sql'>>;
const devNoteField = objectField({
	id: stringField(),
	created: stringField(),
	updated: stringField(),
	category: stringField(),
	relatedSectionIds: arrayField(stringField()),
	content: stringField(),
	source: stringField(),
} satisfies CompleteFieldSchema<DevNoteEntry>, true, [], [
	'id', 'created', 'updated', 'category', 'content', 'source',
]);
const devnotesSectionSchema = {
	id: stringField(),
	type: stringField(),
	entries: arrayField(devNoteField, ['id'], 'stable'),
} satisfies CompleteFieldSchema<KnownSection<'devnotes'>>;

const KNOWN_SECTION_SCHEMAS: Readonly<Record<KnownSectionKind, Readonly<Record<string, JsonFieldSchema>>>> = {
	query: querySectionSchema,
	copilotQuery: copilotQuerySectionSchema,
	markdown: markdownSectionSchema,
	python: pythonSectionSchema,
	url: urlSectionSchema,
	chart: chartSectionSchema,
	transformation: transformationSectionSchema,
	html: htmlSectionSchema,
	sql: sqlSectionSchema,
	devnotes: devnotesSectionSchema,
};
const ALWAYS_PRESERVE_OMITTED_SECTION_TYPES = new Set<string>(['devnotes']);

const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const sectionType = (section: KqlxSectionV1): string =>
	String((section as Record<string, unknown>)?.type ?? '');
const canonicalSectionType = (section: KqlxSectionV1): string =>
	canonicalKnownSectionKind(sectionType(section)) ?? sectionType(section);
const sectionId = (section: KqlxSectionV1): string =>
	String((section as Record<string, unknown>)?.id ?? '').trim();
const sectionIdentityKey = (section: KqlxSectionV1): string =>
	`${canonicalSectionType(section)}\u0000${sectionId(section) || '<idless>'}`;
const isKnownSectionType = (value: string): value is KnownSectionKind => isKnownSectionKind(value);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

function invalidKnownShape(
	value: Record<string, unknown>,
	schema: Readonly<Record<string, JsonFieldSchema>>,
	path: string,
	requiredKeys: readonly string[] = [],
): string | undefined {
	for (const requiredKey of requiredKeys) {
		if (!hasOwn(value, requiredKey) || value[requiredKey] === undefined) return `${path}.${requiredKey}`;
	}
	for (const [key, fieldSchema] of Object.entries(schema)) {
		if (!hasOwn(value, key) || value[key] === undefined) continue;
		const item = value[key];
		const fieldPath = `${path}.${key}`;
		if (fieldSchema.kind === 'unknown') continue;
		if (fieldSchema.kind === 'primitive') {
			if (typeof item !== fieldSchema.primitive
				|| (fieldSchema.primitive === 'number' && !Number.isFinite(item))) return fieldPath;
			continue;
		}
		if (fieldSchema.kind === 'record') {
			if (!isObject(item)) return fieldPath;
			if (fieldSchema.value.kind === 'primitive') {
				for (const [member, memberValue] of Object.entries(item)) {
					if (typeof memberValue !== fieldSchema.value.primitive
						|| (fieldSchema.value.primitive === 'number' && !Number.isFinite(memberValue))) {
						return `${fieldPath}.${member}`;
					}
				}
			}
			continue;
		}
		if (fieldSchema.kind === 'object') {
			if (!isObject(item)) return fieldPath;
			const nested = invalidKnownShape(item, fieldSchema.fields, fieldPath, fieldSchema.requiredKeys);
			if (nested) return nested;
			continue;
		}
		if (!Array.isArray(item)) return fieldPath;
		for (let index = 0; index < item.length; index++) {
			const arrayItem = item[index];
			const itemPath = `${fieldPath}[${index}]`;
			if (fieldSchema.item.kind === 'unknown') continue;
			if (fieldSchema.item.kind === 'primitive') {
				if (typeof arrayItem !== fieldSchema.item.primitive
					|| (fieldSchema.item.primitive === 'number' && !Number.isFinite(arrayItem))) return itemPath;
				continue;
			}
			if (!isObject(arrayItem)) return itemPath;
			const nested = invalidKnownShape(arrayItem, fieldSchema.item.fields, itemPath, fieldSchema.item.requiredKeys);
			if (nested) return nested;
		}
	}
	return undefined;
}

export function getInvalidKqlxKnownFieldShape(section: unknown): string | undefined {
	if (!isObject(section)) return undefined;
	const type = String(section.type ?? '');
	if (!isKnownSectionType(type)) return undefined;
	return invalidKnownShape(section, KNOWN_SECTION_SCHEMAS[type], `section(${type})`);
}

function cloneJsonValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (value === null || typeof value !== 'object') return value;
	const existing = seen.get(value as object);
	if (existing !== undefined) return existing as T;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const item of value) clone.push(cloneJsonValue(item, seen));
		return clone as T;
	}
	const clone: Record<string, unknown> = {};
	seen.set(value as object, clone);
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		setOwn(clone, key, cloneJsonValue(item, seen));
	}
	return clone as T;
}

function extensionOnly(base: unknown, schema: JsonObjectFieldSchema): Record<string, unknown> | undefined {
	if (!isObject(base)) return undefined;
	const extensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(base)) {
		const fieldSchema = hasOwn(schema.fields, key) ? schema.fields[key] : undefined;
		if (!fieldSchema) {
			setOwn(extensions, key, cloneJsonValue(value));
		} else if (
			fieldSchema.kind === 'object'
			&& fieldSchema.preserveExtensionsWhenOmitted
		) {
			const nested = extensionOnly(value, fieldSchema);
			if (nested && Object.keys(nested).length > 0) setOwn(extensions, key, nested);
		}
	}
	return Object.keys(extensions).length > 0 ? extensions : undefined;
}

function exactExtensions(base: unknown, schema: JsonObjectFieldSchema): Record<string, unknown> | undefined {
	if (!isObject(base)) return undefined;
	const extensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(base)) {
		const fieldSchema = hasOwn(schema.fields, key) ? schema.fields[key] : undefined;
		if (!fieldSchema) {
			setOwn(extensions, key, cloneJsonValue(value));
		} else if (fieldSchema.kind === 'object') {
			const nested = exactExtensions(value, fieldSchema);
			if (nested) setOwn(extensions, key, nested);
		} else if (fieldSchema.kind === 'array' && Array.isArray(value) && fieldSchema.item.kind === 'object') {
			const itemSchema = fieldSchema.item;
			const entries = value.map(item => exactExtensions(item, itemSchema) ?? null);
			if (entries.some(item => item !== null)) setOwn(extensions, key, entries);
		}
	}
	return Object.keys(extensions).length > 0 ? extensions : undefined;
}

function knownProjection(value: unknown, schema: JsonObjectFieldSchema): unknown {
	if (!isObject(value)) return cloneJsonValue(value);
	const projected: Record<string, unknown> = {};
	for (const [key, fieldSchema] of Object.entries(schema.fields)) {
		if (!hasOwn(value, key)) continue;
		const item = value[key];
		if (fieldSchema.kind === 'object') setOwn(projected, key, knownProjection(item, fieldSchema));
		else if (fieldSchema.kind === 'array' && Array.isArray(item)) {
			setOwn(projected, key, fieldSchema.item.kind === 'object'
				? item.map(entry => knownProjection(entry, fieldSchema.item as JsonObjectFieldSchema))
				: cloneJsonValue(item));
		} else setOwn(projected, key, cloneJsonValue(item));
	}
	return projected;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => exactJsonEqual(item, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index] && exactJsonEqual(leftRecord[key], rightRecord[key]));
}

export function getKqlxPreservedEnvelope(
	file: KqlxFileV1,
	state: KqlxStateV1 = file.state,
): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(file)) {
		if (key !== 'kind' && key !== 'version' && key !== 'state') setOwn(root, key, cloneJsonValue(value));
	}
	const stateExtensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(state)) {
		if (key !== 'caretDocsEnabled' && key !== 'autoTriggerAutocompleteEnabled' && key !== 'sections') {
			setOwn(stateExtensions, key, cloneJsonValue(value));
		}
	}
	const sections = state.sections.map(section => {
		const type = sectionType(section);
		if (!isKnownSectionType(type)) {
			return { type, id: sectionId(section), passthrough: cloneJsonValue(section) };
		}
		const extensions = exactExtensions(section, {
			kind: 'object', fields: KNOWN_SECTION_SCHEMAS[type], preserveExtensionsWhenOmitted: true,
			identityKeys: [], requiredKeys: [],
		});
		return {
			type: canonicalSectionType(section),
			id: sectionId(section),
			...(extensions ? { extensions } : {}),
		};
	});
	return { root, state: stateExtensions, sections };
}

function identityKeyName(identityKey: JsonIdentityKey): string {
	return typeof identityKey === 'string' ? identityKey : identityKey.key;
}

function valueIdentity(value: Record<string, unknown>, keys: readonly JsonIdentityKey[]): string | undefined {
	if (keys.length === 0) return undefined;
	const values: string[] = [];
	for (const identityKey of keys) {
		const key = identityKeyName(identityKey);
		const normalized = String(value[key] ?? '').trim();
		if (!normalized && typeof identityKey === 'string') return undefined;
		values.push(`${key}\u0001${normalized || '<missing>'}`);
	}
	return values.join('\u0000');
}

function knownShapeIdentity(
	value: Record<string, unknown>,
	schema: JsonObjectFieldSchema,
	omitKeys: readonly string[] = [],
): string {
	const projection = knownProjection(value, schema);
	if (!isObject(projection)) return JSON.stringify(projection);
	const filtered: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(projection)) {
		if (!omitKeys.includes(key)) setOwn(filtered, key, item);
	}
	return JSON.stringify(filtered);
}

function overlayArray(base: unknown[], edited: unknown[], schema: JsonArrayFieldSchema): unknown[] {
	const itemSchema = schema.item;
	if (itemSchema.kind !== 'object') return cloneJsonValue(edited);
	const queues = new Map<string, Record<string, unknown>[]>();
	const knownShapeQueues = new Map<string, Record<string, unknown>[]>();
	const renamedShapeQueues = new Map<string, Record<string, unknown>[]>();
	const baseCounts = new Map<string, number>();
	const editedCounts = new Map<string, number>();
	const baseKnownShapeCounts = new Map<string, number>();
	const editedKnownShapeCounts = new Map<string, number>();
	const baseRenamedShapeCounts = new Map<string, number>();
	const editedRenamedShapeCounts = new Map<string, number>();
	for (const item of base) {
		if (!isObject(item)) continue;
		const identity = valueIdentity(item, schema.identityKeys);
		if (identity) {
			baseCounts.set(identity, (baseCounts.get(identity) ?? 0) + 1);
			queues.set(identity, [...(queues.get(identity) ?? []), item]);
		}
		const knownShape = knownShapeIdentity(item, itemSchema);
		baseKnownShapeCounts.set(knownShape, (baseKnownShapeCounts.get(knownShape) ?? 0) + 1);
		knownShapeQueues.set(knownShape, [...(knownShapeQueues.get(knownShape) ?? []), item]);
		if (schema.identityMode === 'renameable') {
			const renamedShape = knownShapeIdentity(item, itemSchema, schema.identityKeys.map(identityKeyName));
			baseRenamedShapeCounts.set(renamedShape, (baseRenamedShapeCounts.get(renamedShape) ?? 0) + 1);
			renamedShapeQueues.set(renamedShape, [...(renamedShapeQueues.get(renamedShape) ?? []), item]);
		}
	}
	for (const item of edited) {
		if (!isObject(item)) continue;
		const identity = valueIdentity(item, schema.identityKeys);
		if (identity) editedCounts.set(identity, (editedCounts.get(identity) ?? 0) + 1);
		const knownShape = knownShapeIdentity(item, itemSchema);
		editedKnownShapeCounts.set(knownShape, (editedKnownShapeCounts.get(knownShape) ?? 0) + 1);
		if (schema.identityMode === 'renameable') {
			const renamedShape = knownShapeIdentity(item, itemSchema, schema.identityKeys.map(identityKeyName));
			editedRenamedShapeCounts.set(renamedShape, (editedRenamedShapeCounts.get(renamedShape) ?? 0) + 1);
		}
	}
	const positionalSequenceMatches = base.length === edited.length && base.every((item, index) =>
		exactJsonEqual(knownProjection(item, itemSchema), knownProjection(edited[index], itemSchema)),
	);
	const usedBase = new Set<Record<string, unknown>>();
	let unmatchedEdited = 0;
	const takeUnused = (queue: Record<string, unknown>[] | undefined): Record<string, unknown> | undefined => {
		while (queue?.length) {
			const candidate = queue.shift()!;
			if (!usedBase.has(candidate)) {
				usedBase.add(candidate);
				return candidate;
			}
		}
		return undefined;
	};
	const result = edited.map((item, index) => {
		if (!isObject(item)) return cloneJsonValue(item);
		const identity = valueIdentity(item, schema.identityKeys);
		const unambiguous = !!identity && baseCounts.get(identity) === 1 && editedCounts.get(identity) === 1;
		let baseItem = unambiguous ? takeUnused(queues.get(identity!)) : undefined;
		const knownShape = knownShapeIdentity(item, itemSchema);
		if (!baseItem && baseKnownShapeCounts.get(knownShape) === 1 && editedKnownShapeCounts.get(knownShape) === 1) {
			baseItem = takeUnused(knownShapeQueues.get(knownShape));
		}
		if (!baseItem && schema.identityMode === 'renameable') {
			const renamedShape = knownShapeIdentity(item, itemSchema, schema.identityKeys.map(identityKeyName));
			if (baseRenamedShapeCounts.get(renamedShape) === 1 && editedRenamedShapeCounts.get(renamedShape) === 1) {
				baseItem = takeUnused(renamedShapeQueues.get(renamedShape));
			}
		}
		if (!baseItem && positionalSequenceMatches && isObject(base[index]) && !usedBase.has(base[index] as Record<string, unknown>)) {
			baseItem = base[index] as Record<string, unknown>;
			usedBase.add(baseItem);
		}
		if (!baseItem) unmatchedEdited++;
		return baseItem ? overlayObject(baseItem, item, itemSchema) : cloneJsonValue(item);
	});
	const wouldLoseExtensions = base.some(item => {
		if (!isObject(item) || usedBase.has(item) || !exactExtensions(item, itemSchema)) return false;
		const identity = valueIdentity(item, schema.identityKeys);
		const isUnambiguousDeletion = !!identity
			&& baseCounts.get(identity) === 1
			&& (editedCounts.get(identity) ?? 0) === 0;
		return !isUnambiguousDeletion;
	});
	if (wouldLoseExtensions && (unmatchedEdited > 0 || edited.length !== base.length)) {
		throw new KqlxOverlayConflictError('Cannot safely preserve future fields for an ambiguously edited nested array.');
	}
	return result;
}

function overlayObject(
	base: Record<string, unknown>,
	edited: Record<string, unknown>,
	schema: JsonObjectFieldSchema,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(base)) {
		if (!hasOwn(schema.fields, key)) setOwn(result, key, cloneJsonValue(value));
	}
	for (const [key, value] of Object.entries(edited)) {
		if (!hasOwn(schema.fields, key)) setOwn(result, key, cloneJsonValue(value));
	}
	for (const [key, fieldSchema] of Object.entries(schema.fields)) {
		if (hasOwn(edited, key)) {
			const editedValue = edited[key];
			const baseValue = base[key];
			if (fieldSchema.kind === 'object' && isObject(baseValue) && isObject(editedValue)) {
				const baseIdentity = valueIdentity(baseValue, fieldSchema.identityKeys);
				const editedIdentity = valueIdentity(editedValue, fieldSchema.identityKeys);
				setOwn(result, key, fieldSchema.identityKeys.length > 0 && baseIdentity !== editedIdentity
					? cloneJsonValue(editedValue)
					: overlayObject(baseValue, editedValue, fieldSchema));
			} else if (fieldSchema.kind === 'array' && Array.isArray(baseValue) && Array.isArray(editedValue)) {
				setOwn(result, key, overlayArray(baseValue, editedValue, fieldSchema));
			} else {
				setOwn(result, key, cloneJsonValue(editedValue));
			}
		} else if (fieldSchema.kind === 'object'
			&& fieldSchema.preserveExtensionsWhenOmitted
		) {
			const nested = extensionOnly(base[key], fieldSchema);
			if (nested) setOwn(result, key, nested);
		}
	}
	return result;
}

function overlayKnownSection(base: KqlxSectionV1, edited: KqlxSectionV1): KqlxSectionV1 {
	const type = sectionType(edited);
	if (!isKnownSectionType(type)) return cloneJsonValue(edited);
	return overlayObject(
		base as Record<string, unknown>,
		edited as Record<string, unknown>,
		{
			kind: 'object', fields: KNOWN_SECTION_SCHEMAS[type], preserveExtensionsWhenOmitted: true,
			identityKeys: [], requiredKeys: [],
		},
	) as KqlxSectionV1;
}

function enqueueIndex(queues: Map<string, number[]>, key: string, index: number): void {
	queues.set(key, [...(queues.get(key) ?? []), index]);
}

function overlaySections(
	baseSections: readonly KqlxSectionV1[],
	editedSections: readonly KqlxSectionV1[],
): KqlxSectionV1[] {
	const isPassthrough = (section: KqlxSectionV1) => {
		const type = sectionType(section);
		return !isKnownSectionType(type)
			|| ALWAYS_PRESERVE_OMITTED_SECTION_TYPES.has(type);
	};
	const baseEditableQueues = new Map<string, number[]>();
	const baseIdlessEditableQueues = new Map<string, number[]>();
	const basePassthroughQueues = new Map<string, number[]>();
	for (let index = 0; index < baseSections.length; index++) {
		const section = baseSections[index];
		if (isPassthrough(section)) enqueueIndex(basePassthroughQueues, sectionIdentityKey(section), index);
		else {
			enqueueIndex(baseEditableQueues, sectionIdentityKey(section), index);
			if (!sectionId(section)) enqueueIndex(baseIdlessEditableQueues, canonicalSectionType(section), index);
		}
	}
	const usedBase = new Set<number>();
	const dequeue = (queue: number[] | undefined): number | undefined => {
		while (queue?.length) {
			const index = queue.shift()!;
			if (!usedBase.has(index)) {
				usedBase.add(index);
				return index;
			}
		}
		return undefined;
	};
	const matchedBaseToCore = new Map<number, number>();
	const passthroughReplacementByBase = new Map<number, KqlxSectionV1>();
	const core: KqlxSectionV1[] = [];
	for (const section of editedSections) {
		if (isPassthrough(section)) {
			const baseIndex = dequeue(basePassthroughQueues.get(sectionIdentityKey(section)));
			if (baseIndex !== undefined) {
				const replacement = ALWAYS_PRESERVE_OMITTED_SECTION_TYPES.has(sectionType(section))
					? overlayKnownSection(baseSections[baseIndex], section)
					: cloneJsonValue(section);
				passthroughReplacementByBase.set(baseIndex, replacement);
			}
			else core.push(cloneJsonValue(section));
			continue;
		}
		let baseIndex = dequeue(baseEditableQueues.get(sectionIdentityKey(section)));
		if (baseIndex === undefined && sectionId(section)) {
			baseIndex = dequeue(baseIdlessEditableQueues.get(canonicalSectionType(section)));
		}
		const coreIndex = core.length;
		core.push(baseIndex === undefined
			? cloneJsonValue(section)
			: overlayKnownSection(baseSections[baseIndex], section));
		if (baseIndex !== undefined) matchedBaseToCore.set(baseIndex, coreIndex);
	}
	const insertionSlots = new Map<number, KqlxSectionV1[]>();
	const pushAtSlot = (slot: number, section: KqlxSectionV1) => {
		insertionSlots.set(slot, [...(insertionSlots.get(slot) ?? []), cloneJsonValue(section)]);
	};
	let lastPassthroughSlot = 0;
	for (let baseIndex = 0; baseIndex < baseSections.length; baseIndex++) {
		const section = baseSections[baseIndex];
		const preservesOmittedSection = ALWAYS_PRESERVE_OMITTED_SECTION_TYPES.has(sectionType(section))
			&& !usedBase.has(baseIndex);
		if (!isPassthrough(section) && !preservesOmittedSection) continue;
		const preserved = passthroughReplacementByBase.get(baseIndex) ?? section;
		let previousEditedIndex: number | undefined;
		for (let index = baseIndex - 1; index >= 0; index--) {
			previousEditedIndex = matchedBaseToCore.get(index);
			if (previousEditedIndex !== undefined) break;
		}
		let nextEditedIndex: number | undefined;
		for (let index = baseIndex + 1; index < baseSections.length; index++) {
			nextEditedIndex = matchedBaseToCore.get(index);
			if (nextEditedIndex !== undefined) break;
		}
		const preferredSlot = nextEditedIndex !== undefined
			? nextEditedIndex
			: previousEditedIndex !== undefined
				? previousEditedIndex + 1
				: core.length;
		const slot = Math.min(core.length, Math.max(lastPassthroughSlot, preferredSlot));
		pushAtSlot(slot, preserved);
		lastPassthroughSlot = slot;
	}
	const result: KqlxSectionV1[] = [];
	for (let index = 0; index < core.length; index++) {
		result.push(...(insertionSlots.get(index) ?? []), core[index]);
	}
	result.push(...(insertionSlots.get(core.length) ?? []));
	return result;
}

export function overlayKqlxFileState(
	baseFile: KqlxFileV1,
	editedState: KqlxStateV1,
	kind: KqlxFileKind = baseFile.kind,
): KqlxFileV1 {
	const baseState = isObject(baseFile.state) ? baseFile.state : { sections: [] };
	const stateExtensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(baseState)) {
		if (key !== 'caretDocsEnabled' && key !== 'autoTriggerAutocompleteEnabled' && key !== 'sections') {
			setOwn(stateExtensions, key, cloneJsonValue(value));
		}
	}
	for (const [key, value] of Object.entries(editedState)) {
		if (key !== 'caretDocsEnabled' && key !== 'autoTriggerAutocompleteEnabled' && key !== 'sections') {
			setOwn(stateExtensions, key, cloneJsonValue(value));
		}
	}
	const state: KqlxStateV1 = {
		...stateExtensions,
		sections: overlaySections(
			Array.isArray(baseState.sections) ? baseState.sections as KqlxSectionV1[] : [],
			Array.isArray(editedState.sections) ? editedState.sections : [],
		),
	};
	if (typeof editedState.caretDocsEnabled === 'boolean') state.caretDocsEnabled = editedState.caretDocsEnabled;
	if (typeof editedState.autoTriggerAutocompleteEnabled === 'boolean') {
		state.autoTriggerAutocompleteEnabled = editedState.autoTriggerAutocompleteEnabled;
	}
	const rootExtensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(baseFile)) {
		if (key !== 'kind' && key !== 'version' && key !== 'state') {
			setOwn(rootExtensions, key, cloneJsonValue(value));
		}
	}
	return { ...rootExtensions, kind, version: 1, state };
}
