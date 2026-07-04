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
