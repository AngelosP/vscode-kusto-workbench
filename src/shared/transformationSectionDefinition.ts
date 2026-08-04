export interface TransformationAggregationState {
	name?: string;
	column?: string;
	function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct';
}

export interface TransformationDeriveColumnState {
	name: string;
	expression: string;
}

export interface TransformationJoinKeyState {
	left: string;
	right: string;
}

export interface PersistedTransformationSectionState {
	id?: string;
	type: 'transformation';
	name?: string;
	mode?: 'edit' | 'preview';
	expanded?: boolean;
	editorHeightPx?: number;
	dataSourceId?: string;
	transformationType?: 'derive' | 'summarize' | 'distinct' | 'pivot' | 'join';
	distinctColumn?: string;
	groupByColumns?: string[];
	aggregations?: TransformationAggregationState[];
	deriveColumns?: TransformationDeriveColumnState[];
	deriveColumnName?: string;
	deriveExpression?: string;
	pivotRowKeyColumn?: string;
	pivotColumnKeyColumn?: string;
	pivotValueColumn?: string;
	pivotAggregation?: 'sum' | 'avg' | 'count' | 'first';
	pivotMaxColumns?: number;
	joinRightDataSourceId?: string;
	joinKind?: 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftanti' | 'rightanti' | 'leftsemi' | 'rightsemi';
	joinKeys?: TransformationJoinKeyState[];
	joinOmitDuplicateColumns?: boolean;
}

export interface TransformationSectionState extends PersistedTransformationSectionState {
	id: string;
}

type TransformationConfiguration = Omit<PersistedTransformationSectionState, 'id' | 'type'>;
export type TransformationSectionPatch = {
	[K in keyof TransformationConfiguration]?: Exclude<TransformationConfiguration[K], undefined> | null;
};

export type TransformationSectionValidationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: string }>;

type JsonRecord = Record<string, unknown>;
type MutableTransformationState =
	| TransformationSectionState
	| PersistedTransformationSectionState
	| TransformationSectionPatch;

const stringFields = [
	'name', 'mode', 'dataSourceId', 'transformationType', 'distinctColumn',
	'deriveColumnName', 'deriveExpression', 'pivotRowKeyColumn', 'pivotColumnKeyColumn',
	'pivotValueColumn', 'pivotAggregation', 'joinRightDataSourceId', 'joinKind',
] as const;
const booleanFields = ['expanded', 'joinOmitDuplicateColumns'] as const;
const numberFields = ['editorHeightPx', 'pivotMaxColumns'] as const;
const configurationKeys = new Set<string>([
	...stringFields,
	...booleanFields,
	...numberFields,
	'groupByColumns', 'aggregations', 'deriveColumns', 'joinKeys',
]);

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is JsonRecord =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const setOwn = (target: object, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

function cloneJsonValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (!value || typeof value !== 'object') return undefined;
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const clone: unknown[] = [];
		seen.set(value, clone);
		for (const item of value) clone.push(cloneJsonValue(item, seen));
		return clone;
	}
	const clone: JsonRecord = {};
	seen.set(value, clone);
	for (const [key, item] of Object.entries(value)) setOwn(clone, key, cloneJsonValue(item, seen));
	return clone;
}

function readScalarFields(input: JsonRecord, target: MutableTransformationState): string | undefined {
	for (const key of stringFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'string') return `Transformation field "${key}" must be a string.`;
		setOwn(target, key, input[key]);
	}
	for (const key of booleanFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'boolean') return `Transformation field "${key}" must be a boolean.`;
		setOwn(target, key, input[key]);
	}
	for (const key of numberFields) {
		if (!hasOwn(input, key)) continue;
		if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
			return `Transformation field "${key}" must be a finite number.`;
		}
		setOwn(target, key, input[key]);
	}
	return undefined;
}

function readGroupByColumns(input: JsonRecord, target: MutableTransformationState): string | undefined {
	if (!hasOwn(input, 'groupByColumns')) return undefined;
	if (!Array.isArray(input.groupByColumns)
		|| !input.groupByColumns.every(item => typeof item === 'string')) {
		return 'Transformation field "groupByColumns" must be an array of strings.';
	}
	setOwn(target, 'groupByColumns', [...input.groupByColumns]);
	return undefined;
}

function readAggregations(input: JsonRecord, target: MutableTransformationState): string | undefined {
	if (!hasOwn(input, 'aggregations')) return undefined;
	if (!Array.isArray(input.aggregations)) {
		return 'Transformation field "aggregations" must be an array.';
	}
	const values: TransformationAggregationState[] = [];
	for (let index = 0; index < input.aggregations.length; index++) {
		const item = input.aggregations[index];
		if (!isRecord(item) || typeof item.function !== 'string') {
			return `Transformation field "aggregations[${index}]" must contain a string function.`;
		}
		if (item.name !== undefined && typeof item.name !== 'string') {
			return `Transformation field "aggregations[${index}].name" must be a string.`;
		}
		if (item.column !== undefined && typeof item.column !== 'string') {
			return `Transformation field "aggregations[${index}].column" must be a string.`;
		}
		const value = { function: item.function } as TransformationAggregationState;
		if (item.name !== undefined) value.name = item.name;
		if (item.column !== undefined) value.column = item.column;
		values.push(value);
	}
	setOwn(target, 'aggregations', values);
	return undefined;
}

function readDeriveColumns(input: JsonRecord, target: MutableTransformationState): string | undefined {
	if (!hasOwn(input, 'deriveColumns')) return undefined;
	if (!Array.isArray(input.deriveColumns)) {
		return 'Transformation field "deriveColumns" must be an array.';
	}
	const values: TransformationDeriveColumnState[] = [];
	for (let index = 0; index < input.deriveColumns.length; index++) {
		const item = input.deriveColumns[index];
		if (!isRecord(item) || typeof item.name !== 'string' || typeof item.expression !== 'string') {
			return `Transformation field "deriveColumns[${index}]" must contain string name and expression fields.`;
		}
		values.push({ name: item.name, expression: item.expression });
	}
	setOwn(target, 'deriveColumns', values);
	return undefined;
}

function readJoinKeys(input: JsonRecord, target: MutableTransformationState): string | undefined {
	if (!hasOwn(input, 'joinKeys')) return undefined;
	if (!Array.isArray(input.joinKeys)) return 'Transformation field "joinKeys" must be an array.';
	const values: TransformationJoinKeyState[] = [];
	for (let index = 0; index < input.joinKeys.length; index++) {
		const item = input.joinKeys[index];
		if (!isRecord(item) || typeof item.left !== 'string' || typeof item.right !== 'string') {
			return `Transformation field "joinKeys[${index}]" must contain string left and right fields.`;
		}
		values.push({ left: item.left, right: item.right });
	}
	setOwn(target, 'joinKeys', values);
	return undefined;
}

function readOptionalFields(
	input: JsonRecord,
	target: MutableTransformationState,
	allowNullDeletion: boolean,
): string | undefined {
	if (allowNullDeletion) {
		for (const key of Object.keys(input)) {
			if (configurationKeys.has(key) && input[key] === null) setOwn(target, key, null);
		}
	}
	const nonNullInput: JsonRecord = {};
	for (const [key, value] of Object.entries(input)) {
		if (!(allowNullDeletion && value === null)) setOwn(nonNullInput, key, value);
	}
	return readScalarFields(nonNullInput, target)
		?? readGroupByColumns(nonNullInput, target)
		?? readAggregations(nonNullInput, target)
		?? readDeriveColumns(nonNullInput, target)
		?? readJoinKeys(nonNullInput, target);
}

export function parseTransformationSection(
	input: unknown,
): TransformationSectionValidationResult<TransformationSectionState> {
	if (!isRecord(input) || input.type !== 'transformation') {
		return { ok: false, error: 'Transformation section must be an object with type "transformation".' };
	}
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!id || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) {
		return { ok: false, error: 'Transformation section must have a safe, non-empty ID.' };
	}
	const value: TransformationSectionState = { id, type: 'transformation' };
	const error = readOptionalFields(input, value, false);
	return error ? { ok: false, error } : { ok: true, value };
}

export function parseTransformationSectionPatch(
	input: unknown,
): TransformationSectionValidationResult<TransformationSectionPatch> {
	if (!isRecord(input)) return { ok: false, error: 'Transformation patch must be an object.' };
	const value: TransformationSectionPatch = {};
	const error = readOptionalFields(input, value, true);
	return error ? { ok: false, error } : { ok: true, value };
}

export function patchTransformationSection(
	section: TransformationSectionState,
	patch: TransformationSectionPatch,
): TransformationSectionState {
	const next = cloneJsonValue(section) as TransformationSectionState;
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete (next as unknown as JsonRecord)[key];
		else setOwn(next, key, cloneJsonValue(value));
	}
	next.id = section.id;
	next.type = 'transformation';
	return next;
}

export function validatePersistedTransformationSection(input: unknown): string | undefined {
	if (!isRecord(input) || input.type !== 'transformation') {
		return 'Transformation section must be an object with type "transformation".';
	}
	const value: PersistedTransformationSectionState = { type: 'transformation' };
	return readOptionalFields(input, value, false);
}
