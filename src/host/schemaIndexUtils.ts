import * as crypto from 'crypto';

import { DatabaseSchemaIndex } from './kustoClient';

/**
 * Describes how aggressively the schema was pruned to fit within a token budget.
 * Each phase removes more information:
 *   0 = full schema (no pruning)
 *   1 = data types dropped
 *   2 = docstrings dropped (+ phase 1)
 *   3 = columns dropped (+ phases 1-2)
 *   4 = function parameters dropped (+ phases 1-3)
 *   5 = schema truncated with a cut-off message (+ phases 1-4)
 */
export type SchemaPrunePhase = 0 | 1 | 2 | 3 | 4 | 5;

export interface SchemaPruneResult {
	/** The formatted schema text. */
	text: string;
	/** The pruning phase that was applied. 0 means the full schema fit. */
	phase: SchemaPrunePhase;
	/** Token count of the final schema text. */
	tokenCount: number;
	/** The token budget that was used. */
	tokenBudget: number;
}

/** Human-readable description of each pruning phase (for labels and notifications). */
export const PRUNE_PHASE_DESCRIPTIONS: Record<SchemaPrunePhase, string> = {
	0: 'full schema',
	1: 'data types removed',
	2: 'data types and docstrings removed',
	3: 'column details removed',
	4: 'column and function parameter details removed',
	5: 'schema truncated due to context window limits',
};

const _derivedColumnsCache = new WeakMap<object, Record<string, string[]>>();

const sortStrings = (values: string[]): string[] => values.sort((a, b) => a.localeCompare(b));

const CLR_TO_CSL_TYPE: Record<string, string> = {
	'system.string': 'string',
	'system.byte': 'uint8',
	'system.int16': 'int16',
	'system.uint16': 'uint16',
	'system.int64': 'long',
	'system.int32': 'int',
	'system.uint32': 'uint',
	'system.uint64': 'ulong',
	'system.datetime': 'datetime',
	'system.timespan': 'timespan',
	'system.double': 'real',
	'system.single': 'float',
	'system.sbyte': 'bool',
	'system.boolean': 'bool',
	'newtonsoft.json.linq.jarray': 'dynamic',
	'newtonsoft.json.linq.jobject': 'dynamic',
	'newtonsoft.json.linq.jtoken': 'dynamic',
	'system.object': 'dynamic',
	'system.guid': 'guid',
	'system.decimal': 'decimal',
	'system.data.sqltypes.sqldecimal': 'decimal',
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAcyclicJsonValue(value: unknown, ancestors: WeakSet<object> = new WeakSet()): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return true;
	if (!value || typeof value !== 'object') return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		return (Array.isArray(value) ? value : Object.values(value)).every(item => isAcyclicJsonValue(item, ancestors));
	} finally {
		ancestors.delete(value);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	return text || undefined;
}

function toCslType(value: unknown): string {
	const type = nonEmptyString(value) || 'dynamic';
	return CLR_TO_CSL_TYPE[type.toLowerCase()] || type;
}

function toShowSchemaColumn(name: string, type: unknown, docString?: unknown): JsonObject {
	const rawType = nonEmptyString(type) || 'dynamic';
	return {
		Name: name,
		Type: rawType,
		CslType: toCslType(rawType),
		...(nonEmptyString(docString) ? { DocString: nonEmptyString(docString) } : {}),
	};
}

function parseCompactTabularColumns(value: unknown): JsonObject[] | undefined {
	const type = nonEmptyString(value);
	if (!type || !type.startsWith('(') || !type.endsWith(')')) return undefined;
	const inner = type.slice(1, -1).trim();
	if (!inner || inner === '*') return [];
	const columns: JsonObject[] = [];
	for (const definition of inner.split(',')) {
		const part = definition.trim();
		if (!part) return undefined;
		const separator = part.indexOf(':');
		const name = (separator >= 0 ? part.slice(0, separator) : part).trim();
		const columnType = (separator >= 0 ? part.slice(separator + 1) : 'dynamic').trim();
		if (!name || !columnType) return undefined;
		columns.push(toShowSchemaColumn(name, columnType));
	}
	return columns;
}

function toShowSchemaParameter(value: unknown): JsonObject | undefined {
	if (!isJsonObject(value)) return undefined;
	const name = nonEmptyString(value.name);
	if (!name) return undefined;
	const tabularColumns = parseCompactTabularColumns(value.type);
	if (tabularColumns) {
		return { Name: name, Columns: tabularColumns };
	}
	const rawType = nonEmptyString(value.type);
	if (rawType?.startsWith('(')) return undefined;
	if (!rawType) return { Name: name, Columns: [] };
	const cslType = toCslType(rawType);
	return {
		Name: name,
		Type: rawType,
		CslType: cslType,
		...(value.defaultValue !== undefined && typeof value.defaultValue !== 'object'
			? { CslDefaultValue: String(value.defaultValue) }
			: {}),
	};
}

function isValidShowSchemaColumn(value: unknown): boolean {
	return isJsonObject(value)
		&& !!nonEmptyString(value.Name)
		&& !!nonEmptyString(value.Type)
		&& !!nonEmptyString(value.CslType);
}

function isValidShowSchemaTableContainer(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	return Object.values(value).every(table => isJsonObject(table)
		&& !!nonEmptyString(table.Name)
		&& Array.isArray(table.OrderedColumns)
		&& table.OrderedColumns.every(isValidShowSchemaColumn));
}

function isValidShowSchemaParameter(value: unknown): boolean {
	if (!isJsonObject(value) || !nonEmptyString(value.Name)) return false;
	if (value.Columns !== undefined) {
		return Array.isArray(value.Columns) && value.Columns.every(isValidShowSchemaColumn);
	}
	return !!nonEmptyString(value.Type) && !!nonEmptyString(value.CslType);
}

function isValidShowSchemaFunctionContainer(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	return Object.values(value).every(fn => isJsonObject(fn)
		&& !!nonEmptyString(fn.Name)
		&& typeof fn.Body === 'string'
		&& Array.isArray(fn.InputParameters)
		&& fn.InputParameters.every(isValidShowSchemaParameter));
}

function isValidShowSchemaDatabase(value: unknown): value is JsonObject {
	if (!isJsonObject(value)
		|| !nonEmptyString(value.Name)
		|| !Number.isFinite(value.MajorVersion)
		|| !Number.isFinite(value.MinorVersion)
		|| !isValidShowSchemaTableContainer(value.Tables)
		|| !isValidShowSchemaFunctionContainer(value.Functions)
		|| !isJsonObject(value.Graphs)) {
		return false;
	}
	if (value.ExternalTables !== undefined && !isValidShowSchemaTableContainer(value.ExternalTables)) return false;
	if (value.MaterializedViews !== undefined && !isValidShowSchemaTableContainer(value.MaterializedViews)) return false;
	if (value.EntityGroups !== undefined && (!isJsonObject(value.EntityGroups)
		|| !Object.values(value.EntityGroups).every(Array.isArray))) return false;
	return Object.values(value.Graphs).every(graph => isJsonObject(graph)
		&& !!nonEmptyString(graph.Name)
		&& Array.isArray(graph.Nodes)
		&& Array.isArray(graph.Edges)
		&& Array.isArray(graph.Snapshots));
}

function parseUsableRawSchemaJson(value: unknown, database: string): JsonObject | undefined {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!isJsonObject(parsed) || !isAcyclicJsonValue(parsed) || !isJsonObject(parsed.Databases)) return undefined;
	const databases = Object.entries(parsed.Databases);
	if (databases.length === 0 || !databases.every(([, candidate]) => isValidShowSchemaDatabase(candidate))) return undefined;
	const requestedName = database.trim().toLowerCase();
	const target = databases.find(([key, candidate]) => key.toLowerCase() === requestedName
		&& nonEmptyString((candidate as JsonObject).Name)?.toLowerCase() === requestedName)?.[1] as JsonObject | undefined;
	if (!target) return undefined;
	return parsed;
}

/** Build the Monaco-Kusto show-schema shape from the persisted compact index. */
export function synthesizeRawSchemaJson(schema: DatabaseSchemaIndex, database: string): unknown | undefined {
	try {
		const databaseName = nonEmptyString(database);
		if (!databaseName || !isJsonObject(schema)) return undefined;
		const compactTables = Array.isArray(schema.tables)
			? schema.tables.map(nonEmptyString).filter((name): name is string => !!name)
			: [];
		const columnTypesByTable = isJsonObject(schema.columnTypesByTable) ? schema.columnTypesByTable : {};
		const tableNames = Array.from(new Set([
			...compactTables,
			...Object.keys(columnTypesByTable).map(nonEmptyString).filter((name): name is string => !!name),
		]));
		const tableDocStrings = isJsonObject(schema.tableDocStrings) ? schema.tableDocStrings : {};
		const columnDocStrings = isJsonObject(schema.columnDocStrings) ? schema.columnDocStrings : {};
		const tables: Record<string, unknown> = Object.fromEntries(tableNames.map(tableName => {
			const columnTypes = isJsonObject(columnTypesByTable[tableName]) ? columnTypesByTable[tableName] : {};
			const columns = Object.entries(columnTypes).flatMap(([columnName, type]) => {
				const name = nonEmptyString(columnName);
				if (!name || (typeof type !== 'string' && typeof type !== 'number')) return [];
				return [toShowSchemaColumn(name, type, columnDocStrings[`${tableName}.${name}`])];
			});
			return [tableName, {
				Name: tableName,
				EntityType: 'Table',
				OrderedColumns: columns,
				...(nonEmptyString(tableDocStrings[tableName]) ? { DocString: nonEmptyString(tableDocStrings[tableName]) } : {}),
			}];
		}));
		const functions: Record<string, unknown> = {};
		for (const fn of Array.isArray(schema.functions) ? schema.functions : []) {
			if (!isJsonObject(fn)) continue;
			const name = nonEmptyString(fn.name);
			if (!name) continue;
			const inputParameters = (Array.isArray(fn.parameters) ? fn.parameters : [])
				.map(toShowSchemaParameter)
				.filter((parameter): parameter is JsonObject => !!parameter);
			functions[name] = {
				Name: name,
				InputParameters: inputParameters,
				Body: typeof fn.body === 'string' ? fn.body : '',
				Folder: typeof fn.folder === 'string' ? fn.folder : '',
				DocString: typeof fn.docString === 'string' ? fn.docString : '',
				FunctionKind: 'StoredFunction',
				OutputColumns: [],
			};
		}
		if (Object.keys(tables).length === 0 && Object.keys(functions).length === 0) return undefined;
		return {
			Plugins: [],
			Databases: {
				[databaseName]: {
					Name: databaseName,
					Tables: tables,
					ExternalTables: {},
					MaterializedViews: {},
					EntityGroups: {},
					MajorVersion: 0,
					MinorVersion: 0,
					Functions: functions,
					Graphs: {},
					DatabaseAccessMode: 'ReadWrite',
				},
			},
		};
	} catch {
		return undefined;
	}
}

export function ensureRawSchemaJson(schema: DatabaseSchemaIndex, database: string): DatabaseSchemaIndex {
	if (parseUsableRawSchemaJson(schema.rawSchemaJson, database)) return schema;
	const rawSchemaJson = synthesizeRawSchemaJson(schema, database);
	if (rawSchemaJson) return { ...schema, rawSchemaJson };
	if (schema.rawSchemaJson !== undefined) {
		const { rawSchemaJson: _invalidRawSchemaJson, ...compactSchema } = schema;
		return compactSchema;
	}
	return schema;
}

/**
 * Returns a `columnsByTable`-shaped view derived from `columnTypesByTable`.
 *
 * Notes:
 * - This avoids storing duplicate column lists in the persisted schema cache.
 * - For backward compatibility, if an older cached schema still has `columnsByTable`, we use it.
 */
export const getColumnsByTable = (schema: DatabaseSchemaIndex | undefined | null): Record<string, string[]> => {
	const s: any = schema as any;
	if (s && s.columnsByTable && typeof s.columnsByTable === 'object') {
		return s.columnsByTable as Record<string, string[]>;
	}

	if (!schema || !schema.columnTypesByTable || typeof schema.columnTypesByTable !== 'object') {
		return {};
	}

	const cached = _derivedColumnsCache.get(schema as any);
	if (cached) {
		return cached;
	}

	const out: Record<string, string[]> = {};
	for (const [table, types] of Object.entries(schema.columnTypesByTable)) {
		if (!types || typeof types !== 'object') {
			continue;
		}
		out[table] = sortStrings(Object.keys(types).map((c) => String(c)));
	}

	_derivedColumnsCache.set(schema as any, out);
	return out;
};

export const countColumns = (schema: DatabaseSchemaIndex | undefined | null): number => {
	let count = 0;
	const colsByTable = getColumnsByTable(schema);
	for (const cols of Object.values(colsByTable)) {
		count += Array.isArray(cols) ? cols.length : 0;
	}
	return count;
};

export const getSchemaSummary = (schema: DatabaseSchemaIndex | undefined | null): { tablesCount: number; columnsCount: number; functionsCount: number; hasRawSchemaJson: boolean } => ({
	tablesCount: Array.isArray(schema?.tables) ? schema.tables.length : 0,
	columnsCount: countColumns(schema),
	functionsCount: Array.isArray(schema?.functions) ? schema.functions.length : 0,
	hasRawSchemaJson: !!schema?.rawSchemaJson,
});

function stableForSignature(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
	if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
		return String(value);
	}
	if (value === undefined) return null;
	if (!value || typeof value !== 'object') {
		return value;
	}
	if (ancestors.has(value)) return '[Circular]';
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map(item => stableForSignature(item, ancestors));
		}
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
			out[key] = stableForSignature((value as Record<string, unknown>)[key], ancestors);
		}
		return out;
	} finally {
		ancestors.delete(value);
	}
}

export const getAutocompleteSchemaSignature = (schema: DatabaseSchemaIndex | undefined | null): string => {
	if (!schema) {
		return 'sha256:empty';
	}
	const tableNames = Array.isArray(schema.tables)
		? schema.tables.map(table => String(table || '')).filter(Boolean).sort((a, b) => a.localeCompare(b))
		: [];
	const columnTypesByTable: Record<string, Record<string, string>> = {};
	for (const table of Object.keys(schema.columnTypesByTable || {}).sort((a, b) => a.localeCompare(b))) {
		const columns = schema.columnTypesByTable?.[table] || {};
		columnTypesByTable[table] = {};
		for (const column of Object.keys(columns).sort((a, b) => a.localeCompare(b))) {
			columnTypesByTable[table][column] = String(columns[column] || '');
		}
	}
	const functions = (Array.isArray(schema.functions) ? schema.functions : [])
		.map(fn => ({
			name: String(fn?.name || ''),
			parametersText: String(fn?.parametersText || ''),
			parameters: (Array.isArray(fn?.parameters) ? fn.parameters : []).map(param => ({
				name: String(param?.name || ''),
				type: String(param?.type || ''),
				defaultValue: String(param?.defaultValue || ''),
				raw: String(param?.raw || ''),
			})),
			docString: String(fn?.docString || ''),
			folder: String(fn?.folder || ''),
			body: String(fn?.body || ''),
		}))
		.filter(fn => fn.name)
		.sort((a, b) => a.name.localeCompare(b.name));
	const canonical = stableForSignature({
		tables: tableNames,
		columnTypesByTable,
		tableDocStrings: stableForSignature(schema.tableDocStrings || {}),
		tableFolders: stableForSignature(schema.tableFolders || {}),
		columnDocStrings: stableForSignature(schema.columnDocStrings || {}),
		functions,
		rawSchemaJson: schema.rawSchemaJson ? stableForSignature(schema.rawSchemaJson) : null,
	});
	const json = JSON.stringify(canonical);
	return 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
};

/**
 * Type abbreviation map for compact schema format.
 * Maps common Kusto types to short codes to reduce token usage.
 * Includes both KQL type names (string, datetime) and .NET type names (System.String, System.DateTime).
 */
export const TYPE_ABBREVIATIONS: Record<string, string> = {
	// KQL type names
	string: 's',
	long: 'l',
	int: 'i',
	datetime: 'dt',
	timespan: 'ts',
	real: 'r',
	double: 'r',
	bool: 'b',
	boolean: 'b',
	dynamic: 'd',
	guid: 'g',
	decimal: 'dec',
	// .NET type names (from JSON schema)
	'system.string': 's',
	'system.int64': 'l',
	'system.int32': 'i',
	'system.datetime': 'dt',
	'system.timespan': 'ts',
	'system.double': 'r',
	'system.single': 'r',
	'system.sbyte': 'b',
	'system.boolean': 'b',
	'system.object': 'd',
	'system.guid': 'g',
	'system.decimal': 'dec'
};

/**
 * Abbreviates a Kusto type to a short code.
 */
export const abbreviateType = (type: string): string => {
	const normalized = (type || '').toLowerCase().trim();
	return TYPE_ABBREVIATIONS[normalized] || type;
};

/**
 * Formats a database schema in a compact text format optimized for LLM consumption.
 * This format uses significantly fewer tokens than JSON while remaining highly readable.
 *
 * Format:
 * ```
 * Database: MyDb
 * Types: s=string, l=long, i=int, dt=datetime, ts=timespan, r=real, b=bool, d=dynamic, g=guid, dec=decimal
 *
 * # Tables
 * RootTable: Id(l), Name(s)
 * ## Sales
 * Orders: Id(l), UserId(l), Amount(dec)
 * Products: Id(l), Name(s), Price(dec)
 * ## System
 * Logs: Id(l), Message(s), Timestamp(dt)
 *
 * # Functions
 * GetActiveUsers(minDate:dt, maxAge:i)
 * ## Sales
 * GetOrders(startDate:dt, endDate:dt)
 * CalculateRevenue(year:i)
 * ```
 *
 * Tables and functions are grouped by folder. Items without a folder appear first,
 * followed by folders in alphabetical order (## FolderName headers).
 */
export const formatSchemaAsCompactText = (
	database: string,
	schema: DatabaseSchemaIndex,
	meta?: { cacheAgeMs?: number; tablesCount?: number; columnsCount?: number; functionsCount?: number }
): string => {
	const lines: string[] = [];

	// Header with database name
	lines.push(`Database: ${database || '(unknown)'}`);

	// Type legend
	lines.push('Types: s=string, l=long, i=int, dt=datetime, ts=timespan, r=real, b=bool, d=dynamic, g=guid, dec=decimal');

	// Meta info (optional, compact)
	if (meta) {
		const parts: string[] = [];
		if (meta.tablesCount !== undefined) parts.push(`${meta.tablesCount} tables`);
		if (meta.columnsCount !== undefined) parts.push(`${meta.columnsCount} columns`);
		if (meta.functionsCount !== undefined) parts.push(`${meta.functionsCount} functions`);
		if (meta.cacheAgeMs !== undefined) {
			const mins = Math.round(meta.cacheAgeMs / 60000);
			parts.push(`cached ${mins}m ago`);
		}
		if (parts.length > 0) {
			lines.push(`Info: ${parts.join(', ')}`);
		}
	}

	lines.push('');

	// Tables section
	const tables = schema.tables || [];
	const columnTypes = schema.columnTypesByTable || {};
	const tableFolders = schema.tableFolders || {};

	if (tables.length > 0) {
		lines.push('# Tables');
		const tableDocStrings = schema.tableDocStrings || {};
		const columnDocStrings = schema.columnDocStrings || {};

		// Group tables by folder
		const tablesByFolder: Record<string, string[]> = {};
		for (const table of tables) {
			const folder = tableFolders[table] || '';
			if (!tablesByFolder[folder]) {
				tablesByFolder[folder] = [];
			}
			tablesByFolder[folder].push(table);
		}

		// Sort folders (empty folder first, then alphabetically)
		const sortedFolders = Object.keys(tablesByFolder).sort((a, b) => {
			if (!a && b) return -1;
			if (a && !b) return 1;
			return a.localeCompare(b);
		});

		// Helper to format a single table line
		const formatTableLine = (table: string): string => {
			const cols = columnTypes[table];
			const tableDoc = tableDocStrings[table];

			if (cols && typeof cols === 'object') {
				const colParts = Object.entries(cols)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([colName, colType]) => {
						const colDoc = columnDocStrings[`${table}.${colName}`];
						const typeAbbrev = abbreviateType(colType);
						// Include column docstring inline if present
						if (colDoc) {
							return `${colName}(${typeAbbrev} "${colDoc}")`;
						}
						return `${colName}(${typeAbbrev})`;
					});
				// Add table docstring as a comment at the end if present
				if (tableDoc) {
					return `${table}: ${colParts.join(', ')}  // ${tableDoc}`;
				} else {
					return `${table}: ${colParts.join(', ')}`;
				}
			} else {
				if (tableDoc) {
					return `${table}: (no columns)  // ${tableDoc}`;
				} else {
					return `${table}: (no columns)`;
				}
			}
		};

		// Output tables grouped by folder
		for (const folder of sortedFolders) {
			const folderTables = tablesByFolder[folder].sort((a, b) => a.localeCompare(b));
			if (folder) {
				// Folder header
				lines.push(`## ${folder}`);
			}
			for (const table of folderTables) {
				lines.push(formatTableLine(table));
			}
		}
	} else {
		lines.push('# Tables');
		lines.push('(none)');
	}

	// Functions section
	const functions = schema.functions || [];
	if (functions.length > 0) {
		lines.push('');
		lines.push('# Functions');

		// Group functions by folder
		const functionsByFolder: Record<string, typeof functions> = {};
		for (const fn of functions) {
			const folder = fn.folder || '';
			if (!functionsByFolder[folder]) {
				functionsByFolder[folder] = [];
			}
			functionsByFolder[folder].push(fn);
		}

		// Sort folders (empty folder first, then alphabetically)
		const sortedFnFolders = Object.keys(functionsByFolder).sort((a, b) => {
			if (!a && b) return -1;
			if (a && !b) return 1;
			return a.localeCompare(b);
		});

		// Helper to format a single function line
		const formatFunctionLine = (fn: typeof functions[0]): string => {
			let fnLine = '';
			if (fn.parameters && fn.parameters.length > 0) {
				const params = fn.parameters
					.map((p) => {
						const typeStr = p.type ? `:${abbreviateType(p.type)}` : '';
						const defaultStr = p.defaultValue ? `=${p.defaultValue}` : '';
						return `${p.name}${typeStr}${defaultStr}`;
					})
					.join(', ');
				fnLine = `${fn.name}(${params})`;
			} else if (fn.parametersText) {
				fnLine = `${fn.name}(${fn.parametersText})`;
			} else {
				fnLine = `${fn.name}()`;
			}
			// Add function docstring as comment if present
			if (fn.docString) {
				return `${fnLine}  // ${fn.docString}`;
			}
			return fnLine;
		};

		// Output functions grouped by folder
		for (const folder of sortedFnFolders) {
			const folderFunctions = functionsByFolder[folder].sort((a, b) => a.name.localeCompare(b.name));
			if (folder) {
				// Folder header
				lines.push(`## ${folder}`);
			}
			for (const fn of folderFunctions) {
				lines.push(formatFunctionLine(fn));
			}
		}
	}

	return lines.join('\n');
};

// ── Progressive pruning helpers ────────────────────────────────────────────

/**
 * Options for controlling how the schema is formatted at each pruning phase.
 */
export interface SchemaFormatOptions {
	/** Omit type abbreviations from column definitions. */
	dropTypes?: boolean;
	/** Omit table/column/function docstrings. */
	dropDocStrings?: boolean;
	/** Omit individual columns entirely – just list table names. */
	dropColumns?: boolean;
	/** Omit function parameters – just list function names. */
	dropFunctionParams?: boolean;
}

/**
 * Low-level formatter that supports all pruning knobs.
 * The public `formatSchemaAsCompactText` always calls this with all flags off (phase 0).
 */
export const formatSchemaWithOptions = (
	database: string,
	schema: DatabaseSchemaIndex,
	meta: { cacheAgeMs?: number; tablesCount?: number; columnsCount?: number; functionsCount?: number } | undefined,
	options: SchemaFormatOptions
): string => {
	const lines: string[] = [];

	// Header
	lines.push(`Database: ${database || '(unknown)'}`);

	// Type legend (only relevant when types are shown)
	if (!options.dropTypes && !options.dropColumns) {
		lines.push('Types: s=string, l=long, i=int, dt=datetime, ts=timespan, r=real, b=bool, d=dynamic, g=guid, dec=decimal');
	}

	// Meta info
	if (meta) {
		const parts: string[] = [];
		if (meta.tablesCount !== undefined) parts.push(`${meta.tablesCount} tables`);
		if (meta.columnsCount !== undefined) parts.push(`${meta.columnsCount} columns`);
		if (meta.functionsCount !== undefined) parts.push(`${meta.functionsCount} functions`);
		if (meta.cacheAgeMs !== undefined) {
			const mins = Math.round(meta.cacheAgeMs / 60000);
			parts.push(`cached ${mins}m ago`);
		}
		if (parts.length > 0) {
			lines.push(`Info: ${parts.join(', ')}`);
		}
	}

	lines.push('');

	// ── Tables ──────────────────────────────────────────────────────────────
	const tables = schema.tables || [];
	const columnTypes = schema.columnTypesByTable || {};
	const tableFolders = schema.tableFolders || {};

	if (tables.length > 0) {
		lines.push('# Tables');
		const tableDocStrings = (!options.dropDocStrings && schema.tableDocStrings) ? schema.tableDocStrings : {};
		const columnDocStrings = (!options.dropDocStrings && schema.columnDocStrings) ? schema.columnDocStrings : {};

		// Group by folder
		const tablesByFolder: Record<string, string[]> = {};
		for (const table of tables) {
			const folder = tableFolders[table] || '';
			if (!tablesByFolder[folder]) tablesByFolder[folder] = [];
			tablesByFolder[folder].push(table);
		}
		const sortedFolders = Object.keys(tablesByFolder).sort((a, b) => {
			if (!a && b) return -1;
			if (a && !b) return 1;
			return a.localeCompare(b);
		});

		const formatTableLine = (table: string): string => {
			if (options.dropColumns) {
				// No columns at all
				const tableDoc = tableDocStrings[table];
				return tableDoc ? `${table}  // ${tableDoc}` : table;
			}

			const cols = columnTypes[table];
			const tableDoc = tableDocStrings[table];

			if (cols && typeof cols === 'object') {
				const colParts = Object.entries(cols)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([colName, colType]) => {
						if (options.dropTypes) {
							const colDoc = columnDocStrings[`${table}.${colName}`];
							if (colDoc) return `${colName} "${colDoc}"`;
							return colName;
						}
						const colDoc = columnDocStrings[`${table}.${colName}`];
						const typeAbbrev = abbreviateType(colType);
						if (colDoc) return `${colName}(${typeAbbrev} "${colDoc}")`;
						return `${colName}(${typeAbbrev})`;
					});
				if (tableDoc) return `${table}: ${colParts.join(', ')}  // ${tableDoc}`;
				return `${table}: ${colParts.join(', ')}`;
			}
			if (tableDoc) return `${table}: (no columns)  // ${tableDoc}`;
			return `${table}: (no columns)`;
		};

		for (const folder of sortedFolders) {
			const folderTables = tablesByFolder[folder].sort((a, b) => a.localeCompare(b));
			if (folder) lines.push(`## ${folder}`);
			for (const table of folderTables) {
				lines.push(formatTableLine(table));
			}
		}
	} else {
		lines.push('# Tables');
		lines.push('(none)');
	}

	// ── Functions ───────────────────────────────────────────────────────────
	const functions = schema.functions || [];
	if (functions.length > 0) {
		lines.push('');
		lines.push('# Functions');

		const functionsByFolder: Record<string, typeof functions> = {};
		for (const fn of functions) {
			const folder = fn.folder || '';
			if (!functionsByFolder[folder]) functionsByFolder[folder] = [];
			functionsByFolder[folder].push(fn);
		}
		const sortedFnFolders = Object.keys(functionsByFolder).sort((a, b) => {
			if (!a && b) return -1;
			if (a && !b) return 1;
			return a.localeCompare(b);
		});

		const formatFnLine = (fn: typeof functions[0]): string => {
			let fnLine: string;
			if (options.dropFunctionParams) {
				fnLine = `${fn.name}()`;
			} else if (fn.parameters && fn.parameters.length > 0) {
				const params = fn.parameters
					.map((p) => {
						const typeStr = (!options.dropTypes && p.type) ? `:${abbreviateType(p.type)}` : '';
						const defaultStr = p.defaultValue ? `=${p.defaultValue}` : '';
						return `${p.name}${typeStr}${defaultStr}`;
					})
					.join(', ');
				fnLine = `${fn.name}(${params})`;
			} else if (!options.dropFunctionParams && fn.parametersText) {
				fnLine = `${fn.name}(${fn.parametersText})`;
			} else {
				fnLine = `${fn.name}()`;
			}
			if (!options.dropDocStrings && fn.docString) {
				return `${fnLine}  // ${fn.docString}`;
			}
			return fnLine;
		};

		for (const folder of sortedFnFolders) {
			const folderFunctions = functionsByFolder[folder].sort((a, b) => a.name.localeCompare(b.name));
			if (folder) lines.push(`## ${folder}`);
			for (const fn of folderFunctions) {
				lines.push(formatFnLine(fn));
			}
		}
	}

	return lines.join('\n');
};

/**
 * Default maximum fraction of the model's input token budget that the schema tool result
 * is allowed to consume. The rest is needed for conversation history, system prompt,
 * tool definitions, and model output.
 */
export const DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION = 0.40;

/**
 * Progressively prunes the schema format to fit within a token budget.
 *
 * `countTokens` is an async function that returns an approximate token count
 * for a given string (typically backed by `model.countTokens()`).
 *
 * Phases (applied in order until the result fits):
 *   0 – full schema
 *   1 – drop data types
 *   2 – drop docstrings
 *   3 – drop columns
 *   4 – drop function parameters
 *   5 – hard-truncate and append a cut-off notice
 */
export const formatSchemaWithTokenBudget = async (
	database: string,
	schema: DatabaseSchemaIndex,
	meta: { cacheAgeMs?: number; tablesCount?: number; columnsCount?: number; functionsCount?: number } | undefined,
	tokenBudget: number,
	countTokens: (text: string) => PromiseLike<number>
): Promise<SchemaPruneResult> => {
	// Phase 0 – full schema (identical to the existing formatSchemaAsCompactText output)
	const fullText = formatSchemaAsCompactText(database, schema, meta);
	const fullTokens = await countTokens(fullText);
	if (fullTokens <= tokenBudget) {
		return { text: fullText, phase: 0, tokenCount: fullTokens, tokenBudget };
	}

	// Phases 1-4: progressively strip information
	const phases: { phase: SchemaPrunePhase; options: SchemaFormatOptions }[] = [
		{ phase: 1, options: { dropTypes: true } },
		{ phase: 2, options: { dropTypes: true, dropDocStrings: true } },
		{ phase: 3, options: { dropTypes: true, dropDocStrings: true, dropColumns: true } },
		{ phase: 4, options: { dropTypes: true, dropDocStrings: true, dropColumns: true, dropFunctionParams: true } },
	];

	for (const { phase, options } of phases) {
		const text = formatSchemaWithOptions(database, schema, meta, options);
		const tokens = await countTokens(text);
		if (tokens <= tokenBudget) {
			return { text: addPruneNotice(text, phase), phase, tokenCount: tokens, tokenBudget };
		}
	}

	// Phase 5 – hard-truncate the most reduced version
	const minimalText = formatSchemaWithOptions(database, schema, meta, {
		dropTypes: true,
		dropDocStrings: true,
		dropColumns: true,
		dropFunctionParams: true,
	});
	const truncated = await truncateToTokenBudget(minimalText, tokenBudget, countTokens);
	const truncatedTokens = await countTokens(truncated);
	return { text: truncated, phase: 5, tokenCount: truncatedTokens, tokenBudget };
};

/**
 * Appends a brief notice to the schema text describing what was removed.
 */
export function addPruneNotice(text: string, phase: SchemaPrunePhase): string {
	if (phase === 0) return text;
	return text + '\n\n' + `[Note: Schema was reduced to fit context window – ${PRUNE_PHASE_DESCRIPTIONS[phase]}. Ask the user to provide specific table or column names if needed.]`;
}

/**
 * Performs a binary-search-style truncation to fit within a token budget,
 * appending a cut-off notice at the end.
 */
async function truncateToTokenBudget(
	text: string,
	tokenBudget: number,
	countTokens: (text: string) => PromiseLike<number>
): Promise<string> {
	const CUTOFF_NOTICE = '\n\n... schema cut off due to context window limits. Ask the user for specific table or column names.';
	// Reserve tokens for the notice itself
	const noticeTokens = await countTokens(CUTOFF_NOTICE);
	const availableBudget = Math.max(1, tokenBudget - noticeTokens);

	// Binary search on character length (token count is roughly proportional)
	let lo = 0;
	let hi = text.length;
	let bestLen = 0;

	// First check if the whole text fits with the notice
	const fullTokens = await countTokens(text);
	if (fullTokens <= availableBudget) {
		return text + CUTOFF_NOTICE;
	}

	// Rough initial estimate: scale down proportionally
	const initialGuess = Math.floor((availableBudget / fullTokens) * text.length);
	hi = Math.min(hi, initialGuess + Math.floor(initialGuess * 0.2)); // slight overshoot for search space

	for (let i = 0; i < 10; i++) { // max 10 iterations should converge
		const mid = Math.floor((lo + hi) / 2);
		if (mid <= lo) break;
		const candidate = text.slice(0, mid);
		const tokens = await countTokens(candidate);
		if (tokens <= availableBudget) {
			bestLen = mid;
			lo = mid;
		} else {
			hi = mid;
		}
	}

	// Try to break at a newline for cleaner output
	const tentative = text.slice(0, bestLen);
	const lastNewline = tentative.lastIndexOf('\n');
	const cleanText = lastNewline > 0 ? tentative.slice(0, lastNewline) : tentative;

	return cleanText + CUTOFF_NOTICE;
}
