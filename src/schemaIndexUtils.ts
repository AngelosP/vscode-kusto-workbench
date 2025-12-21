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
