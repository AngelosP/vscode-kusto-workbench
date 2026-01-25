import { DatabaseSchemaIndex } from './kustoClient';

const _derivedColumnsCache = new WeakMap<object, Record<string, string[]>>();

const sortStrings = (values: string[]): string[] => values.sort((a, b) => a.localeCompare(b));

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

/**
 * Type abbreviation map for compact schema format.
 * Maps common Kusto types to short codes to reduce token usage.
 * Includes both KQL type names (string, datetime) and .NET type names (System.String, System.DateTime).
 */
const TYPE_ABBREVIATIONS: Record<string, string> = {
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
const abbreviateType = (type: string): string => {
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
