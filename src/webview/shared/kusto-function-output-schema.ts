export function kustoLiteralForSchemaType(type: unknown): string {
	const normalized = String(type || '').trim().toLowerCase();
	if (normalized === 'datetime') return 'datetime(2026-01-01)';
	if (normalized === 'timespan') return '1s';
	if (normalized === 'int' || normalized === 'long') return '1';
	if (normalized === 'real' || normalized === 'double') return '1.0';
	if (normalized === 'bool') return 'true';
	if (normalized === 'guid') return 'guid(00000000-0000-0000-0000-000000000001)';
	if (normalized === 'dynamic') return 'dynamic({})';
	return '""';
}

export function getKustoOutputColumnEntries(source: any): Array<[string, any]> {
	const columns = source?.OutputColumns || source?.outputColumns || source?.OrderedColumns || source?.orderedColumns || source?.Columns || source?.columns || {};
	return Array.isArray(columns)
		? columns.map((column: any, index: number) => [column?.Name || column?.name || `Column${index + 1}`, column])
		: Object.entries(columns);
}

export function getKustoColumnNamesFromSchemaEntity(entity: any): string[] {
	try {
		const source = entity?.OrderedColumns || entity?.orderedColumns || entity?.Columns || entity?.columns || entity?.OutputColumns || entity?.outputColumns || {};
		if (Array.isArray(source)) {
			return source.map((column: any, index: number) => {
				if (Array.isArray(column)) return String(column[0] || column[1]?.Name || column[1]?.name || `Column${index + 1}`);
				if (typeof column === 'string') return column;
				return String(column?.Name || column?.name || column?.ColumnName || column?.columnName || `Column${index + 1}`);
			}).filter(Boolean);
		}
		if (typeof source === 'string') {
			return source.split(',').map(part => part.trim().split(':')[0]?.trim()).filter(Boolean);
		}
		return Object.entries(source).map(([name, column]: [string, any]) => String(column?.Name || column?.name || column?.ColumnName || column?.columnName || name)).filter(Boolean);
	} catch {
		return [];
	}
}

type KustoSchemaDatabaseIndex = {
	entry: any;
	entitiesByLowerName: Map<string, any>;
};

type KustoSchemaIndex = {
	databases: any;
	orderedDatabases: KustoSchemaDatabaseIndex[];
	databasesByLowerName: Map<string, KustoSchemaDatabaseIndex>;
};

const kustoSchemaIndexByDatabases = new WeakMap<object, KustoSchemaIndex>();

function addEntityAlias(map: Map<string, any>, name: unknown, entity: any): void {
	const key = String(name || '').trim().toLowerCase();
	if (key && !map.has(key)) {
		map.set(key, entity);
	}
}

export function getKustoSchemaIndex(rawSchemaJson: any): KustoSchemaIndex {
	const databases = rawSchemaJson?.Databases || {};
	if (!databases || typeof databases !== 'object') {
		return { databases: {}, orderedDatabases: [], databasesByLowerName: new Map() };
	}
	const cached = kustoSchemaIndexByDatabases.get(databases);
	if (cached) {
		return cached;
	}
	const orderedDatabases: KustoSchemaDatabaseIndex[] = [];
	const databasesByLowerName = new Map<string, KustoSchemaDatabaseIndex>();
	for (const [databaseKey, dbEntry] of Object.entries(databases) as Array<[string, any]>) {
		const entitiesByLowerName = new Map<string, any>();
		const containers = [dbEntry?.Tables, dbEntry?.MaterializedViews, dbEntry?.ExternalTables, dbEntry?.Functions];
		for (const container of containers) {
			if (!container || typeof container !== 'object') continue;
			for (const [entityKey, entity] of Object.entries(container) as Array<[string, any]>) {
				addEntityAlias(entitiesByLowerName, entityKey, entity);
				addEntityAlias(entitiesByLowerName, entity?.Name || entity?.name, entity);
			}
		}
		const dbIndex = { entry: dbEntry, entitiesByLowerName };
		orderedDatabases.push(dbIndex);
		addEntityAlias(databasesByLowerName as unknown as Map<string, any>, databaseKey, dbIndex);
		addEntityAlias(databasesByLowerName as unknown as Map<string, any>, dbEntry?.Name || dbEntry?.name, dbIndex);
	}
	const index = { databases, orderedDatabases, databasesByLowerName };
	kustoSchemaIndexByDatabases.set(databases, index);
	return index;
}

function findKustoDatabaseIndex(rawSchemaJson: any, database: string): KustoSchemaDatabaseIndex | undefined {
	const index = getKustoSchemaIndex(rawSchemaJson);
	return index.databasesByLowerName.get(String(database || '').toLowerCase()) || index.orderedDatabases[0];
}

export function findKustoRawSchemaEntity(rawSchemaJson: any, database: string, entityName: string): any {
	try {
		const dbIndex = findKustoDatabaseIndex(rawSchemaJson, database);
		return dbIndex?.entitiesByLowerName.get(String(entityName || '').toLowerCase()) || null;
	} catch {
		return null;
	}
}

export function resolveKustoRawSchemaEntityColumns(rawSchemaJson: any, database: string, entityName: string): string[] {
	return getKustoColumnNamesFromSchemaEntity(findKustoRawSchemaEntity(rawSchemaJson, database, entityName));
}

export function resolveKustoRawSchemaEntityColumnsDeep(rawSchemaJson: any, database: string, entityName: string, seen: Set<string> = new Set()): string[] {
	try {
		const key = `${String(database || '').toLowerCase()}|${String(entityName || '').toLowerCase()}`;
		if (!entityName || seen.has(key)) return [];
		seen.add(key);
		const direct = resolveKustoRawSchemaEntityColumns(rawSchemaJson, database, entityName);
		if (direct.length) return direct;
		const entity = findKustoRawSchemaEntity(rawSchemaJson, database, entityName);
		return inferKustoRawFunctionBodyColumns(rawSchemaJson, database, entity?.Body || entity?.body || '', seen);
	} catch {
		return [];
	}
}

export function applyKustoColumnPipelineStages(columns: string[], stages: string[]): string[] {
	let current = Array.from(new Set(columns || []));
	for (const rawStage of stages || []) {
		const stage = String(rawStage || '').trim();
		if (!stage) continue;
		if (/^(where|filter|take|limit|top|order\s+by|sort\s+by)\b/i.test(stage)) continue;
		if (/^project-away\b/i.test(stage)) {
			const remove = new Set((stage.replace(/^project-away\b/i, '').match(/[A-Za-z_][\w-]*/g) || []).map(name => name.toLowerCase()));
			current = current.filter(column => !remove.has(column.toLowerCase()));
			continue;
		}
		if (/^project-rename\b/i.test(stage)) {
			for (const match of stage.replace(/^project-rename\b/i, '').matchAll(/\b([A-Za-z_][\w-]*)\s*=\s*([A-Za-z_][\w-]*)\b/g)) {
				const nextName = match[1];
				const oldName = match[2];
				current = current.map(column => column.toLowerCase() === oldName.toLowerCase() ? nextName : column);
			}
			continue;
		}
		if (/^project-reorder\b/i.test(stage)) continue;
		if (/^project(-keep)?\b/i.test(stage)) {
			const bodyPart = stage.replace(/^project(-keep)?\b/i, '');
			const next = bodyPart.split(',').map(part => {
				const assignment = part.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
				if (assignment) return assignment[1];
				const ident = part.match(/\b([A-Za-z_][\w-]*)\b/);
				return ident ? ident[1] : '';
			}).filter(Boolean);
			if (next.length) current = next;
			continue;
		}
		if (/^extend\b/i.test(stage)) {
			const set = new Set(current);
			for (const match of stage.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) set.add(match[1]);
			current = Array.from(set);
			continue;
		}
		if (/^distinct\b/i.test(stage)) {
			const next = (stage.replace(/^distinct\b/i, '').match(/[A-Za-z_][\w-]*/g) || []);
			if (next.length) current = next;
			continue;
		}
		if (/^summarize\b/i.test(stage)) {
			const by = stage.match(/\bby\b([\s\S]*)$/i)?.[1] || '';
			const next: string[] = (by.match(/[A-Za-z_][\w-]*/g) || []);
			const aggregatePart = stage.split(/\bby\b/i)[0];
			for (const match of aggregatePart.matchAll(/\b([A-Za-z_][\w-]*)\s*=/g)) next.push(match[1]);
			if (!next.length && /\bcount\s*\(\s*\)/i.test(aggregatePart)) next.push('Count');
			current = Array.from(new Set(next));
		}
	}
	return current;
}

export function inferKustoRawFunctionBodyColumns(rawSchemaJson: any, database: string, body: any, seen: Set<string> = new Set()): string[] {
	try {
		const text = String(body || '').replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
		if (/^union\b/i.test(text)) {
			const set = new Set<string>();
			const unionBody = text
				.replace(/^union\b/i, ' ')
				.replace(/\b(kind|isfuzzy|withsource)\s*=\s*("[^"]*"|'[^']*'|[^\s,|)]+)/ig, ' ');
			for (const match of unionBody.matchAll(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/gi)) {
				const name = match[5];
				if (!name || /^(union|kind|isfuzzy|withsource|true|false)$/i.test(name)) continue;
				for (const column of resolveKustoRawSchemaEntityColumnsDeep(rawSchemaJson, match[4] || database, name, new Set(seen))) {
					set.add(column);
				}
			}
			if (set.size) return Array.from(set);
		}
		const sourceMatch = text.match(/(?:cluster\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*)?(?:database\s*\(\s*(['"])(.*?)\3\s*\)\s*\.\s*)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/i);
		if (!sourceMatch) return [];
		const columns = resolveKustoRawSchemaEntityColumnsDeep(rawSchemaJson, sourceMatch[4] || database, sourceMatch[5], new Set(seen));
		if (!columns.length) return [];
		const stages = text.split('|').slice(1).map(stage => stage.trim()).filter(Boolean);
		return applyKustoColumnPipelineStages(columns, stages);
	} catch {
		return [];
	}
}

export function syntheticKustoFunctionBodyForColumnNames(columns: string[]): string {
	const unique = Array.from(new Set((columns || []).map(column => String(column || '').trim()).filter(Boolean)));
	if (!unique.length) return '';
	return `{ print ${unique.map(column => {
		const alias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? column : `["${column.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
		const literal = column.toLowerCase() === 'timestamp' || /time|date/i.test(column) ? 'datetime(2026-01-01)' : '""';
		return `${alias} = ${literal}`;
	}).join(', ')} }`;
}

function collectFunctionsMissingOutputColumns(schemaObj: any): Array<{ databaseName: string; fn: any }> {
	const jobs: Array<{ databaseName: string; fn: any }> = [];
	try {
		const dbs = schemaObj?.Databases || {};
		for (const [databaseName, db] of Object.entries(dbs) as Array<[string, any]>) {
			const functions = db?.Functions || {};
			for (const fn of Object.values(functions) as any[]) {
				if (!fn || typeof fn !== 'object') continue;
				const existingOutputColumns = getKustoColumnNamesFromSchemaEntity({ OutputColumns: fn.OutputColumns || fn.outputColumns || [] });
				if (!existingOutputColumns.length) {
					jobs.push({ databaseName, fn });
				}
			}
		}
	} catch {
		// ignore malformed schemas
	}
	return jobs;
}

function applyInferredFunctionOutput(schemaObj: any, databaseName: string, fn: any): boolean {
	const inferred = inferKustoRawFunctionBodyColumns(schemaObj, databaseName, fn?.Body || fn?.body || '');
	const syntheticBody = syntheticKustoFunctionBodyForColumnNames(inferred);
	if (!syntheticBody) return false;
	const originalBody = String(fn.Body || fn.body || '').trim();
	if (originalBody && !fn.__kustoOriginalBody) fn.__kustoOriginalBody = originalBody;
	fn.OutputColumns = inferred.map((column: string, index: number) => ({
		Name: column,
		Type: /time|date/i.test(column) ? 'datetime' : 'string',
		CslType: /time|date/i.test(column) ? 'datetime' : 'string',
		Ordinal: index,
	}));
	fn.outputColumns = fn.OutputColumns;
	fn.Body = syntheticBody;
	fn.body = syntheticBody;
	return true;
}

export function buildKustoFunctionBodyFromOutputColumns(fn: any): string {
	const entries = getKustoOutputColumnEntries(fn);
	if (!entries.length) return '';
	return `{ print ${entries.map(([colName, col]) => {
		const rawName = String(col?.Name || col?.name || colName || '').trim();
		const alias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName) ? rawName : `["${rawName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
		const type = col?.CslType || col?.cslType || col?.Type || col?.type || 'string';
		return `${alias} = ${kustoLiteralForSchemaType(type)}`;
	}).join(', ')} }`;
}

export function ensureKustoFunctionBodiesForSchema(schemaObj: any): any {
	try {
		if (!schemaObj || !schemaObj.Databases || typeof schemaObj.Databases !== 'object') return schemaObj;
		for (const db of Object.values(schemaObj.Databases) as any[]) {
			const functions = db?.Functions;
			if (!functions || typeof functions !== 'object') continue;
			for (const fn of Object.values(functions) as any[]) {
				if (!fn || typeof fn !== 'object') continue;
				const body = buildKustoFunctionBodyFromOutputColumns(fn);
				if (body) {
					const originalBody = String(fn.Body || fn.body || '').trim();
					if (originalBody && !fn.__kustoOriginalBody) {
						fn.__kustoOriginalBody = originalBody;
					}
					fn.Body = body;
					fn.body = body;
				}
			}
		}
	} catch (error) {
		console.error('[kusto]', error);
	}
	return schemaObj;
}

export function ensureInferredKustoFunctionBodiesForSchema(schemaObj: any): any {
	try {
		for (const { databaseName, fn } of collectFunctionsMissingOutputColumns(schemaObj)) {
			applyInferredFunctionOutput(schemaObj, databaseName, fn);
		}
	} catch (error) {
		console.error('[kusto]', error);
	}
	return schemaObj;
}

export function prepareKustoSchemaForWorkerFast(schemaObj: any): any {
	return ensureKustoFunctionBodiesForSchema(schemaObj);
}

export function prepareKustoSchemaForWorkerFull(schemaObj: any): any {
	return ensureInferredKustoFunctionBodiesForSchema(prepareKustoSchemaForWorkerFast(schemaObj));
}

export function stampKustoSchemaMajorVersion(schemaObj: any, revision: number): any {
	if (!schemaObj || typeof schemaObj !== 'object' || Array.isArray(schemaObj)
		|| !schemaObj.Databases || typeof schemaObj.Databases !== 'object' || Array.isArray(schemaObj.Databases)
		|| !Number.isSafeInteger(revision) || revision <= 0) {
		return schemaObj;
	}
	const databases = Object.fromEntries(Object.entries(schemaObj.Databases).map(([name, database]) => [
		name,
		database && typeof database === 'object' && !Array.isArray(database)
			? { ...database, MajorVersion: revision }
			: database,
	]));
	return { ...schemaObj, Databases: databases };
}

export type KustoSchemaEnhancementResult = {
	processedCount: number;
	enhancedCount: number;
	canceled: boolean;
};

export async function enhanceKustoFunctionBodiesForSchemaChunked(
	schemaObj: any,
	options: { shouldContinue?: () => boolean; maxBatchSize?: number; maxSliceMs?: number; yieldFn?: () => Promise<void> } = {}
): Promise<KustoSchemaEnhancementResult> {
	const jobs = collectFunctionsMissingOutputColumns(schemaObj);
	const maxBatchSize = Math.max(1, options.maxBatchSize ?? 50);
	const maxSliceMs = Math.max(1, options.maxSliceMs ?? 8);
	const yieldFn = options.yieldFn ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
	let processedCount = 0;
	let enhancedCount = 0;
	let sliceStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
	for (const { databaseName, fn } of jobs) {
		if (options.shouldContinue && !options.shouldContinue()) {
			return { processedCount, enhancedCount, canceled: true };
		}
		processedCount++;
		if (applyInferredFunctionOutput(schemaObj, databaseName, fn)) {
			enhancedCount++;
		}
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		if (processedCount % maxBatchSize === 0 || now - sliceStart >= maxSliceMs) {
			await yieldFn();
			sliceStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
		}
	}
	return { processedCount, enhancedCount, canceled: false };
}
