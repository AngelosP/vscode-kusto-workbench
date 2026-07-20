import type { QueryResult } from '../kustoClient';
import type { StsColumnInfo, StsDbCellValue } from './stsProtocol';

function uniqueColumnNames(columns: readonly StsColumnInfo[]): Array<{ name: string; type: string }> {
	const used = new Set<string>();
	return columns.map((column, index) => {
		const base = String(column.columnName || '').trim() || `Column${index + 1}`;
		let name = base;
		let suffix = 2;
		while (used.has(name.toLowerCase())) {
			name = `${base} [${suffix++}]`;
		}
		used.add(name.toLowerCase());
		return { name, type: String(column.dataTypeName || 'unknown') };
	});
}

export function formatStsCell(cell: StsDbCellValue | null | undefined, dataTypeName?: string): {
	display: string;
	full: string;
	isNull?: boolean;
} {
	if (!cell || cell.isNull) return { display: 'null', full: 'null', isNull: true };
	const full = cell.invariantCultureDisplayValue ?? cell.displayValue ?? '';
	if (String(dataTypeName || '').toLowerCase() === 'bit') {
		const normalized = full === '1' || full.toLowerCase() === 'true' ? 'true' : 'false';
		return { display: normalized, full: normalized };
	}
	return {
		display: cell.displayValue ?? full,
		full,
	};
}

export function createQueryResultFromSts(
	columns: readonly StsColumnInfo[],
	rows: readonly (readonly StsDbCellValue[])[],
	metadata: QueryResult['metadata'],
): QueryResult {
	const normalizedColumns = uniqueColumnNames(columns);
	for (const row of rows) {
		if (row.length !== normalizedColumns.length) {
			throw new Error(`SQL Tools Service returned ${row.length} cells for ${normalizedColumns.length} columns.`);
		}
	}
	return {
		columns: normalizedColumns,
		rows: rows.map(row => normalizedColumns.map((column, index) => formatStsCell(row[index], column.type))),
		metadata,
	};
}