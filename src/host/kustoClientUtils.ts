/**
 * Pure utility functions extracted from KustoQueryClient.
 *
 * These functions have zero VS Code imports and can be unit-tested
 * with Vitest without the extension host.
 */

import type { DatabaseSchemaIndex, KustoFunctionInfo, KustoFunctionParameter } from './kustoClient';

// ---------------------------------------------------------------------------
// formatCellValue
// ---------------------------------------------------------------------------

export function formatCellValue(cell: any): { display: string; full: string; isObject?: boolean; isNull?: boolean; rawObject?: any } {
	if (cell === null || cell === undefined) {
		return { display: 'null', full: 'null', isNull: true };
	}
	if (cell instanceof Date) {
		const full = cell.toString();
		const display = cell.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
		return { display, full };
	}
	if (typeof cell === 'object') {
		try {
			const isEmpty = Array.isArray(cell)
				? cell.length === 0
				: Object.keys(cell).length === 0;
			if (isEmpty) {
				const display = Array.isArray(cell) ? '[]' : '{}';
				return { display, full: display };
			}
			const jsonStr = JSON.stringify(cell, null, 2);
			return { display: '[object]', full: jsonStr, isObject: true, rawObject: cell };
		} catch {
			const str = String(cell);
			return { display: str, full: str };
		}
	}

	const str = String(cell);
	const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
	if (isoDateRegex.test(str)) {
		try {
			const date = new Date(str);
			if (!isNaN(date.getTime())) {
				const full = date.toString();
				const display = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
				return { display, full };
			}
		} catch {
			// Not a valid date, fall through
		}
	}
	return { display: str, full: str };
}

// ---------------------------------------------------------------------------
// isLikelyCancellationError
// ---------------------------------------------------------------------------

export function isLikelyCancellationError(error: unknown): boolean {
	const anyErr = error as Record<string, unknown>;
	if (anyErr?.isCancelled === true) {
		return true;
	}
	if (anyErr?.__CANCEL === true) {
		return true;
	}
	if (typeof anyErr?.name === 'string' && anyErr.name === 'AbortError') {
		return true;
	}
	const msg = typeof anyErr?.message === 'string' ? anyErr.message : '';
	return /\b(cancel(l)?ed|canceled|did\s+not\s+consent|user\s+did\s+not\s+consent|consent\s+denied|user\s+cancel(l)?ed)\b/i.test(msg);
}

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

function extractHttpStatusCode(e: any): number | undefined {
	try {
		const direct = e?.statusCode ?? e?.status ?? e?.response?.status ?? e?.response?.statusCode;
		if (typeof direct === 'number' && Number.isFinite(direct)) {
			return direct;
		}
	} catch {
		// ignore
	}
	try {
		const m = String(e?.message ?? '').match(/\bstatus\s*code\s*(401|403)\b/i)
			|| String(e?.message ?? '').match(/\bstatus\s*[:=]\s*(401|403)\b/i)
			|| String(e?.message ?? '').match(/\b(401|403)\b\s*\(?unauthorized\)?/i)
			|| String(e?.message ?? '').match(/\b(401|403)\b\s*\(?forbidden\)?/i);
		if (m?.[1]) {
			const n = Number(m[1]);
			return Number.isFinite(n) ? n : undefined;
		}
	} catch {
		// ignore
	}
	return undefined;
}

export function isAuthError(error: unknown): boolean {
	const anyErr = error as Record<string, unknown>;
	if (anyErr?.isCancelled === true || isLikelyCancellationError(error)) {
		return false;
	}
	const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(error || '');
	const lower = msg.toLowerCase();
	if (lower.includes('aadsts') || lower.includes('aads')) {
		return true;
	}
	if (lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('authorization')) {
		return true;
	}
	const status = extractHttpStatusCode(anyErr)
		?? extractHttpStatusCode(anyErr?.cause)
		?? extractHttpStatusCode(anyErr?.innerError)
		?? extractHttpStatusCode(anyErr?.error)
		?? extractHttpStatusCode(anyErr?.originalError);
	return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// extractSchemaFromJson
// ---------------------------------------------------------------------------

export function extractSchemaFromJson(
	parsed: any,
	columnTypesByTable: Record<string, Record<string, string>>,
	tableDocStrings?: Record<string, string>,
	columnDocStrings?: Record<string, string>,
	tableFolders?: Record<string, string>,
	functions?: KustoFunctionInfo[]
): void {
	if (!parsed) {
		return;
	}

	const addColumn = (tableName: string, colName: string, colType: any, colDocString?: string) => {
		const t = String(tableName);
		const c = String(colName);
		columnTypesByTable[t] ??= {};
		columnTypesByTable[t][c] = colType !== undefined && colType !== null ? String(colType) : '';
		if (colDocString && columnDocStrings) {
			columnDocStrings[`${t}.${c}`] = colDocString;
		}
	};

	const addTableDocString = (tableName: string, docString?: string) => {
		if (docString && tableDocStrings) {
			tableDocStrings[String(tableName)] = docString;
		}
	};

	const addTableFolder = (tableName: string, folder?: string) => {
		if (folder && tableFolders) {
			tableFolders[String(tableName)] = folder;
		}
	};

	const addFunction = (fnObj: any) => {
		if (!functions || !fnObj) {
			return;
		}
		const name = fnObj?.Name ?? fnObj?.name;
		if (!name) {
			return;
		}
		const docString = fnObj?.DocString ?? fnObj?.docString ?? fnObj?.Description ?? fnObj?.description;
		const folder = fnObj?.Folder ?? fnObj?.folder;
		const body = fnObj?.Body ?? fnObj?.body;
		const inputParams = fnObj?.InputParameters ?? fnObj?.inputParameters ?? [];
		const parameters: KustoFunctionParameter[] = [];
		let parametersText = '';
		if (Array.isArray(inputParams)) {
			const paramParts: string[] = [];
			for (const p of inputParams) {
				const pName = p?.Name ?? p?.name;
				if (!pName) {
					continue;
				}
				const cols = p?.Columns ?? p?.columns;
				if (Array.isArray(cols) && cols.length > 0) {
					const colDefs = cols.map((c: any) => {
						const cName = c?.Name ?? c?.name;
						const cType = c?.CslType ?? c?.cslType ?? c?.Type ?? c?.type ?? '';
						return cType ? `${cName}:${cType}` : cName;
					}).join(', ');
					parameters.push({ name: String(pName), type: `(${colDefs})` });
					paramParts.push(`${pName}:(${colDefs})`);
				} else {
					const pType = p?.CslType ?? p?.cslType ?? p?.Type ?? p?.type ?? '';
					const pDefault = p?.CslDefaultValue ?? p?.cslDefaultValue ?? p?.DefaultValue ?? p?.defaultValue ?? '';
					parameters.push({
						name: String(pName),
						type: pType ? String(pType) : undefined,
						defaultValue: pDefault ? String(pDefault) : undefined
					});
					let paramStr = pType ? `${pName}:${pType}` : String(pName);
					if (pDefault) {
						paramStr += `=${pDefault}`;
					}
					paramParts.push(paramStr);
				}
			}
			parametersText = `(${paramParts.join(', ')})`;
		}
		functions.push({
			name: String(name),
			parametersText: parametersText || undefined,
			parameters: parameters.length > 0 ? parameters : undefined,
			docString: docString ? String(docString).trim() : undefined,
			folder: folder ? String(folder).trim() : undefined,
			body: body ? String(body).trim() : undefined
		});
	};

	const databases = parsed.Databases ?? parsed.databases;
	if (databases && typeof databases === 'object' && !Array.isArray(databases)) {
		for (const [_dbKey, dbValue] of Object.entries(databases)) {
			const dbObj: any = dbValue;
			const tablesObj = dbObj?.Tables ?? dbObj?.tables;
			if (tablesObj && typeof tablesObj === 'object' && !Array.isArray(tablesObj)) {
				for (const [tableKey, tableValue] of Object.entries(tablesObj)) {
					const table: any = tableValue;
					const tableName = table?.Name ?? table?.name ?? tableKey;
					if (!tableName) {
						continue;
					}
					const tableDocString = table?.DocString ?? table?.docString ?? table?.Description ?? table?.description;
					if (tableDocString) {
						addTableDocString(String(tableName), String(tableDocString));
					}
					const tableFolder = table?.Folder ?? table?.folder;
					if (tableFolder) {
						addTableFolder(String(tableName), String(tableFolder));
					}
					const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
					if (Array.isArray(cols)) {
						for (const col of cols) {
							const colName = (col as any)?.Name ?? (col as any)?.name;
							const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
							const colDocString = (col as any)?.DocString ?? (col as any)?.docString ?? (col as any)?.Description ?? (col as any)?.description;
							if (colName) {
								addColumn(String(tableName), String(colName), colType, colDocString ? String(colDocString) : undefined);
							}
						}
					}
				}
			}

			const functionsObj = dbObj?.Functions ?? dbObj?.functions;
			if (functionsObj && typeof functionsObj === 'object' && !Array.isArray(functionsObj)) {
				for (const fnValue of Object.values(functionsObj)) {
					addFunction(fnValue);
				}
			}

			const materializedViewsObj = dbObj?.MaterializedViews ?? dbObj?.materializedViews;
			if (materializedViewsObj && typeof materializedViewsObj === 'object' && !Array.isArray(materializedViewsObj)) {
				for (const [viewKey, viewValue] of Object.entries(materializedViewsObj)) {
					const view: any = viewValue;
					const viewName = view?.Name ?? view?.name ?? viewKey;
					if (!viewName) {
						continue;
					}
					const viewDocString = view?.DocString ?? view?.docString ?? view?.Description ?? view?.description;
					if (viewDocString) {
						addTableDocString(String(viewName), String(viewDocString));
					}
					const viewFolder = view?.Folder ?? view?.folder;
					if (viewFolder) {
						addTableFolder(String(viewName), String(viewFolder));
					}
					const cols = view?.Columns ?? view?.columns ?? view?.OrderedColumns ?? view?.orderedColumns;
					if (Array.isArray(cols)) {
						for (const col of cols) {
							const colName = (col as any)?.Name ?? (col as any)?.name;
							const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
							const colDocString = (col as any)?.DocString ?? (col as any)?.docString ?? (col as any)?.Description ?? (col as any)?.description;
							if (colName) {
								addColumn(String(viewName), String(colName), colType, colDocString ? String(colDocString) : undefined);
							}
						}
					}
				}
			}

			const externalTablesObj = dbObj?.ExternalTables ?? dbObj?.externalTables;
			if (externalTablesObj && typeof externalTablesObj === 'object' && !Array.isArray(externalTablesObj)) {
				for (const [extKey, extValue] of Object.entries(externalTablesObj)) {
					const extTable: any = extValue;
					const extName = extTable?.Name ?? extTable?.name ?? extKey;
					if (!extName) {
						continue;
					}
					const extDocString = extTable?.DocString ?? extTable?.docString ?? extTable?.Description ?? extTable?.description;
					if (extDocString) {
						addTableDocString(String(extName), String(extDocString));
					}
					const extFolder = extTable?.Folder ?? extTable?.folder;
					if (extFolder) {
						addTableFolder(String(extName), String(extFolder));
					}
					const cols = extTable?.Columns ?? extTable?.columns ?? extTable?.OrderedColumns ?? extTable?.orderedColumns;
					if (Array.isArray(cols)) {
						for (const col of cols) {
							const colName = (col as any)?.Name ?? (col as any)?.name;
							const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
							const colDocString = (col as any)?.DocString ?? (col as any)?.docString ?? (col as any)?.Description ?? (col as any)?.description;
							if (colName) {
								addColumn(String(extName), String(colName), colType, colDocString ? String(colDocString) : undefined);
							}
						}
					}
				}
			}

			// Recurse into each database object for alternative shapes.
			if (dbObj && typeof dbObj === 'object') {
				extractSchemaFromJson(dbObj, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
			}
		}
		return;
	}

	const tables = parsed.Tables ?? parsed.tables ?? parsed.databaseSchema?.Tables ?? parsed.databaseSchema?.tables;
	if (Array.isArray(tables)) {
		for (const table of tables) {
			const tableName = table?.Name ?? table?.name;
			if (!tableName) {
				continue;
			}
			const tableDocString = table?.DocString ?? table?.docString ?? table?.Description ?? table?.description;
			if (tableDocString) {
				addTableDocString(String(tableName), String(tableDocString));
			}
			const tableFolder = table?.Folder ?? table?.folder;
			if (tableFolder) {
				addTableFolder(String(tableName), String(tableFolder));
			}
			const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
			if (Array.isArray(cols)) {
				for (const col of cols) {
					const colName = col?.Name ?? col?.name;
					const colType = col?.Type ?? col?.type ?? col?.CslType ?? col?.cslType ?? col?.DataType ?? col?.dataType;
					const colDocString = col?.DocString ?? col?.docString ?? col?.Description ?? col?.description;
					if (colName) {
						addColumn(String(tableName), String(colName), colType, colDocString ? String(colDocString) : undefined);
					}
				}
			}
		}
		return;
	}

	if (tables && typeof tables === 'object' && !Array.isArray(tables)) {
		for (const [tableKey, tableValue] of Object.entries(tables)) {
			const table: any = tableValue;
			const tableName = table?.Name ?? table?.name ?? tableKey;
			if (!tableName) {
				continue;
			}
			const tableDocString = table?.DocString ?? table?.docString ?? table?.Description ?? table?.description;
			if (tableDocString) {
				addTableDocString(String(tableName), String(tableDocString));
			}
			const tableFolder = table?.Folder ?? table?.folder;
			if (tableFolder) {
				addTableFolder(String(tableName), String(tableFolder));
			}
			const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
			if (Array.isArray(cols)) {
				for (const col of cols) {
					const colName = (col as any)?.Name ?? (col as any)?.name;
					const colType = (col as any)?.Type ?? (col as any)?.type ?? (col as any)?.CslType ?? (col as any)?.cslType ?? (col as any)?.DataType ?? (col as any)?.dataType;
					const colDocString = (col as any)?.DocString ?? (col as any)?.docString ?? (col as any)?.Description ?? (col as any)?.description;
					if (colName) {
						addColumn(String(tableName), String(colName), colType, colDocString ? String(colDocString) : undefined);
					}
				}
			}
		}
		return;
	}

	// Unknown shape — recursive walk
	if (typeof parsed === 'object') {
		for (const value of Object.values(parsed)) {
			if (Array.isArray(value) || (value && typeof value === 'object')) {
				extractSchemaFromJson(value, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// finalizeSchema
// ---------------------------------------------------------------------------

export function finalizeSchema(
	columnTypesByTable: Record<string, Record<string, string>>,
	tableDocStrings?: Record<string, string>,
	columnDocStrings?: Record<string, string>,
	tableFolders?: Record<string, string>,
	functions?: KustoFunctionInfo[]
): DatabaseSchemaIndex {
	const tables = Object.keys(columnTypesByTable).sort((a, b) => a.localeCompare(b));
	const result: DatabaseSchemaIndex = { tables, columnTypesByTable };
	if (tableDocStrings && Object.keys(tableDocStrings).length > 0) {
		result.tableDocStrings = tableDocStrings;
	}
	if (columnDocStrings && Object.keys(columnDocStrings).length > 0) {
		result.columnDocStrings = columnDocStrings;
	}
	if (tableFolders && Object.keys(tableFolders).length > 0) {
		result.tableFolders = tableFolders;
	}
	if (functions && functions.length > 0) {
		const seen = new Set<string>();
		const deduped: KustoFunctionInfo[] = [];
		for (const f of functions) {
			const key = f.name.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			deduped.push(f);
		}
		deduped.sort((a, b) => a.name.localeCompare(b.name));
		result.functions = deduped;
	}
	return result;
}

// ---------------------------------------------------------------------------
// parseDatabaseSchemaResultWithRaw
// ---------------------------------------------------------------------------

export function parseDatabaseSchemaResultWithRaw(
	result: any,
	commandUsed: string
): { schema: DatabaseSchemaIndex; rawSchemaJson?: unknown } {
	const columnTypesByTable: Record<string, Record<string, string>> = {};
	const tableDocStrings: Record<string, string> = {};
	const columnDocStrings: Record<string, string> = {};
	const tableFolders: Record<string, string> = {};
	const functions: KustoFunctionInfo[] = [];
	const primary = result?.primaryResults?.[0];
	if (!primary) {
		return { schema: { tables: [], columnTypesByTable: {} } };
	}

	let rawSchemaJson: unknown = undefined;

	const isJsonCommand = commandUsed.includes('as json');
	try {
		const rowCandidate = primary.rows ? Array.from(primary.rows())[0] : null;
		if (rowCandidate && typeof rowCandidate === 'object') {
			if (isJsonCommand) {
				for (const key of Object.keys(rowCandidate)) {
					const val = (rowCandidate as Record<string, any>)[key];
					if (val && typeof val === 'object' && val.Databases) {
						rawSchemaJson = val;
						break;
					}
					if (typeof val === 'string') {
						const trimmed = val.trim();
						if (trimmed.startsWith('{')) {
							try {
								const parsed = JSON.parse(trimmed);
								if (parsed && parsed.Databases) {
									rawSchemaJson = parsed;
									break;
								}
							} catch { /* ignore */ }
						}
					}
				}
				if (!rawSchemaJson && (rowCandidate as Record<string, any>).Databases) {
					rawSchemaJson = rowCandidate;
				}
			}

			extractSchemaFromJson(rowCandidate, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
			const direct = finalizeSchema(columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
			if (direct.tables.length > 0) {
				return { schema: direct, rawSchemaJson };
			}

			for (const key of Object.keys(rowCandidate)) {
				const val = (rowCandidate as Record<string, any>)[key];
				if (val && typeof val === 'object') {
					extractSchemaFromJson(val, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
					const finalized = finalizeSchema(columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
					if (finalized.tables.length > 0) {
						return { schema: finalized, rawSchemaJson };
					}
					continue;
				}

				if (typeof val === 'string') {
					const trimmed = val.trim();
					if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
						const parsed = JSON.parse(val);
						extractSchemaFromJson(parsed, columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
						const finalized = finalizeSchema(columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions);
						if (finalized.tables.length > 0) {
							return { schema: finalized, rawSchemaJson };
						}
					}
				}
			}
		}
	} catch {
		// ignore and fall back to tabular parsing
	}

	// Tabular fallback
	const colNames: string[] = (primary.columns ?? []).map((c: any) => String(c.name ?? c.type ?? '')).filter(Boolean);
	const findCol = (candidates: string[]) => {
		const lowered = colNames.map(c => c.toLowerCase());
		for (const cand of candidates) {
			const idx = lowered.indexOf(cand.toLowerCase());
			if (idx >= 0) {
				return colNames[idx];
			}
		}
		return null;
	};
	const tableCol = findCol(['TableName', 'Table', 'Name']);
	const columnCol = findCol(['ColumnName', 'Column', 'Column1', 'Name1']);
	const typeCol = findCol(['ColumnType', 'Type', 'CslType', 'DataType', 'ColumnTypeName']);

	if (primary.rows) {
		for (const row of primary.rows()) {
			const rowObj = row as Record<string, unknown>;
			const tableName = tableCol ? rowObj[tableCol] : rowObj['TableName'];
			const columnName = columnCol ? rowObj[columnCol] : rowObj['ColumnName'];
			const columnType = typeCol ? rowObj[typeCol] : rowObj['ColumnType'];
			if (!tableName || !columnName) {
				continue;
			}
			const t = String(tableName);
			const c = String(columnName);
			columnTypesByTable[t] ??= {};
			columnTypesByTable[t][c] = columnType !== undefined && columnType !== null ? String(columnType) : '';
		}
	}

	return { schema: finalizeSchema(columnTypesByTable, tableDocStrings, columnDocStrings, tableFolders, functions), rawSchemaJson };
}
