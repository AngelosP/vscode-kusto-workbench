import type { KustoQueryResult } from './kustoClient';
import { getKustoResultSets, parseKustoResultBatch } from '../shared/kustoResultBatch';

const DEFAULT_MAX_ROWS = 50;
const DEFAULT_MAX_CELL_CHARACTERS = 2_000;
const DEFAULT_MAX_TOTAL_CHARACTERS = 30_000;

export function summarizeQueryResultForCopilot(result: KustoQueryResult): string {
	const parsed = parseKustoResultBatch(result);
	if (!parsed.ok) return 'No results';
	const sets = getKustoResultSets(parsed.value);
	const totalRows = sets.reduce((sum, set) => sum + set.rows.length, 0);
	if (sets.length > 1) return `${sets.length} result sets, ${totalRows} rows`;
	return totalRows > 0 ? `${totalRows} rows` : 'No results';
}

function columnName(column: KustoQueryResult['columns'][number]): string {
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
	result: KustoQueryResult,
	maxRows: number = DEFAULT_MAX_ROWS,
	maxCellCharacters: number = DEFAULT_MAX_CELL_CHARACTERS,
	maxTotalCharacters: number = DEFAULT_MAX_TOTAL_CHARACTERS,
): string {
	const parsedBatch = parseKustoResultBatch(result);
	const resultSets = parsedBatch.ok ? getKustoResultSets(parsedBatch.value) : [];
	if (resultSets.length > 1) {
		const rowCounts = Array(resultSets.length).fill(0);
		const rowLengths = resultSets.map(set => set.rows.length);
		let assigned = 0;
		while (assigned < Math.max(0, maxRows)) {
			let progressed = false;
			for (let index = 0; index < resultSets.length && assigned < Math.max(0, maxRows); index++) {
				if (rowCounts[index] >= rowLengths[index]) continue;
				rowCounts[index]++;
				assigned++;
				progressed = true;
			}
			if (!progressed) break;
		}
		const sections = resultSets.map((set, index) => {
			const resultName = typeof set.metadata.resultName === 'string'
				? set.metadata.resultName.trim() : '';
			const heading = `Result #${index + 1}${resultName ? ` - ${resultName}` : ''}`;
			const header = set.columns.map(columnName).join('\t');
			const visibleRows = set.rows.slice(0, rowCounts[index]);
			const summary = `${set.rows.length} row${set.rows.length === 1 ? '' : 's'}`
				+ (set.rows.length > visibleRows.length ? `, showing ${visibleRows.length}` : '');
			return [
				heading,
				`Query results (${summary}):`,
				...(header ? [header] : []),
				...visibleRows.map(row => row.map(cell => cellText(cell, maxCellCharacters)).join('\t')),
			].join('\n');
		});
		const text = `${sections.join('\n\n')}\n`;
		return text.length > maxTotalCharacters
			? `${text.slice(0, maxTotalCharacters)}\n...[result preview truncated]\n`
			: text;
	}
	const rows = Array.isArray(result.rows) ? result.rows : [];
	const header = result.columns.map(columnName).join('\t');
	if (rows.length === 0) return header ? `Query returned no results.\nColumns:\n${header}\n` : 'Query returned no results.';
	const visibleRows = rows.slice(0, Math.max(0, maxRows));
	const lines = [
		`Query results (${rows.length} rows${rows.length > visibleRows.length ? `, showing first ${visibleRows.length}` : ''}):`,
		header,
		...visibleRows.map(row => row.map((cell: unknown) => cellText(cell, maxCellCharacters)).join('\t')),
	];
	const text = `${lines.join('\n')}\n`;
	return text.length > maxTotalCharacters
		? `${text.slice(0, maxTotalCharacters)}\n...[result preview truncated]\n`
		: text;
}