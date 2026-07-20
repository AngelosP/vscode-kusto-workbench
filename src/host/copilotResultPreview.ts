import type { QueryResult } from './kustoClient';

const DEFAULT_MAX_ROWS = 50;
const DEFAULT_MAX_CELL_CHARACTERS = 2_000;
const DEFAULT_MAX_TOTAL_CHARACTERS = 30_000;

function columnName(column: QueryResult['columns'][number]): string {
	return typeof column === 'string' ? column : column.name;
}

function cellText(cell: unknown, maxCharacters: number): string {
	let text: string;
	if (cell === null || cell === undefined) return '';
	if (typeof cell === 'object') {
		const value = cell as { display?: unknown; full?: unknown; isNull?: boolean };
		if (value.isNull) return 'null';
		if (value.full !== undefined && value.full !== null) text = String(value.full);
		else if (value.display !== undefined && value.display !== null) text = String(value.display);
		else {
			try { text = JSON.stringify(cell); } catch { text = String(cell); }
		}
	} else {
		text = String(cell);
	}
	text = text.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
	return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}...[truncated]` : text;
}

export function formatQueryResultForCopilot(
	result: QueryResult,
	maxRows: number = DEFAULT_MAX_ROWS,
	maxCellCharacters: number = DEFAULT_MAX_CELL_CHARACTERS,
	maxTotalCharacters: number = DEFAULT_MAX_TOTAL_CHARACTERS,
): string {
	const rows = Array.isArray(result.rows) ? result.rows : [];
	const header = result.columns.map(columnName).join('\t');
	if (rows.length === 0) return header ? `Query returned no results.\nColumns:\n${header}\n` : 'Query returned no results.';
	const visibleRows = rows.slice(0, Math.max(0, maxRows));
	const lines = [
		`Query results (${rows.length} rows${rows.length > visibleRows.length ? `, showing first ${visibleRows.length}` : ''}):`,
		header,
		...visibleRows.map(row => row.map(cell => cellText(cell, maxCellCharacters)).join('\t')),
	];
	const text = `${lines.join('\n')}\n`;
	return text.length > maxTotalCharacters
		? `${text.slice(0, maxTotalCharacters)}\n...[result preview truncated]\n`
		: text;
}