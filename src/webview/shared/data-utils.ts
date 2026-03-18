// Pure data utility functions for chart/transformation data processing.
// No DOM access, no window globals. Extracted from extraBoxes.ts.

/**
 * Extract the raw value from a cell that may be wrapped in {full, display} shape.
 */
export function getRawCellValue(cell: unknown): unknown {
	if (cell && typeof cell === 'object') {
		const obj = cell as Record<string, unknown>;
		if ('full' in obj && obj.full !== undefined && obj.full !== null) return obj.full;
		if ('display' in obj && obj.display !== undefined && obj.display !== null) return obj.display;
	}
	return cell;
}

/**
 * Convert a cell value to a string suitable for chart labels.
 */
export function cellToChartString(cell: unknown): string {
	const raw = getRawCellValue(cell);
	if (raw === null || raw === undefined) return '';
	if (raw instanceof Date) return raw.toISOString();
	if (typeof raw === 'string') return raw;
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
	if (typeof raw === 'object') {
		try { return JSON.stringify(raw); } catch { return '[object]'; }
	}
	return String(raw);
}

/**
 * Convert a cell value to a number for chart plotting.
 */
export function cellToChartNumber(cell: unknown): number | null {
	const raw = getRawCellValue(cell);
	const n = (typeof raw === 'number') ? raw : Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * Convert a cell value to a timestamp in milliseconds for time-axis charts.
 */
export function cellToChartTimeMs(cell: unknown): number | null {
	const raw = getRawCellValue(cell);
	const t = Date.parse(String(raw || ''));
	return Number.isFinite(t) ? t : null;
}

/**
 * Heuristic: infer whether the X-axis column contains time/date values
 * by sampling rows and checking parse rate.
 */
export function inferTimeXAxisFromRows(rows: unknown[][], xIndex: number): boolean {
	const r = Array.isArray(rows) ? rows : [];
	let seen = 0;
	let dateCount = 0;
	for (let i = 0; i < r.length && seen < 50; i++) {
		const row = r[i];
		if (!row) continue;
		const raw = getRawCellValue(row[xIndex]);
		if (raw === null || raw === undefined) continue;
		const s = String(raw).trim();
		if (!s) continue;
		seen++;
		const t = cellToChartTimeMs(raw);
		if (typeof t === 'number' && Number.isFinite(t)) dateCount++;
	}
	if (seen === 0) return false;
	return (dateCount / seen) >= 0.8;
}

/**
 * Normalize a results column descriptor (string or {name:string} object) to a plain string.
 */
export function normalizeResultsColumnName(c: unknown): string {
	if (typeof c === 'string') return c;
	if (c && typeof c === 'object') {
		const obj = c as Record<string, unknown>;
		if (typeof obj.name === 'string') return obj.name;
		if (typeof obj.columnName === 'string') return obj.columnName;
	}
	return '';
}

/**
 * Return the first non-empty string from an array.
 */
export function pickFirstNonEmpty(arr: unknown[]): string {
	for (const v of (arr || [])) {
		const s = String(v || '');
		if (s) return s;
	}
	return '';
}
