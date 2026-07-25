import { kustoEditorSchemaCoordinator } from './kusto-editor-schema-runtime.js';

export type KustoSchemaFunctionParameter = Readonly<{
	name?: string;
	type?: string;
	defaultValue?: unknown;
}>;

export type KustoSchemaFunction = Readonly<{
	name?: string;
	parameters?: readonly KustoSchemaFunctionParameter[];
	parametersText?: string;
	docString?: string;
	body?: string;
}>;

export type KustoEditorSchema = {
	tables: string[];
	columnTypesByTable: Record<string, Record<string, string>>;
	tableDocStrings?: Record<string, string>;
	tableFolders?: Record<string, string>;
	columnDocStrings?: Record<string, string>;
	functions?: KustoSchemaFunction[];
	rawSchemaJson?: unknown;
	[key: string]: unknown;
};

export type SqlEditorSchema = Readonly<{
	tables?: readonly string[];
	views?: readonly string[];
	columnsByTable?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export const sqlSchemaByBoxId: Record<string, SqlEditorSchema | undefined> = {};

function normalizeBoxId(value: unknown): string {
	return String(value || '').trim();
}

export function getKustoEditorSchema(boxId: string): KustoEditorSchema | undefined {
	const id = normalizeBoxId(boxId);
	return id ? kustoEditorSchemaCoordinator.getOwnedState<KustoEditorSchema>(id, 'schema') : undefined;
}

export function setKustoEditorSchema(boxId: string, schema: KustoEditorSchema): void {
	const id = normalizeBoxId(boxId);
	if (id) kustoEditorSchemaCoordinator.setOwnedState(id, 'schema', schema);
}

export function clearKustoEditorSchema(boxId: string): boolean {
	const id = normalizeBoxId(boxId);
	return !!id && kustoEditorSchemaCoordinator.deleteOwnedState(id, 'schema');
}

export function getSqlEditorSchema(boxId: string): SqlEditorSchema | undefined {
	return sqlSchemaByBoxId[normalizeBoxId(boxId)];
}

export function setSqlEditorSchema(boxId: string, schema: SqlEditorSchema): void {
	const id = normalizeBoxId(boxId);
	if (id) sqlSchemaByBoxId[id] = schema;
}

export function clearSqlEditorSchema(boxId: string): boolean {
	const id = normalizeBoxId(boxId);
	if (!id || !(id in sqlSchemaByBoxId)) return false;
	delete sqlSchemaByBoxId[id];
	return true;
}

export function clearAllKustoEditorSchemas(): void {
	kustoEditorSchemaCoordinator.clearOwnedStateSlot('schema');
}

export function clearAllSqlEditorSchemas(): void {
	for (const boxId of Object.keys(sqlSchemaByBoxId)) delete sqlSchemaByBoxId[boxId];
}

export function getKustoEditorSchemaIds(): string[] {
	return kustoEditorSchemaCoordinator.getOwnedStateIds('schema');
}