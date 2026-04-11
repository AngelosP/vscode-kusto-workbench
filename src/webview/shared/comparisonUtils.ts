// Pure utility functions for result comparison and diff.
// Extracted from queryBoxes-execution.ts bridge module for testability.

export function normalizeCellForComparison(cell: any): any {
	const stripNumericGrouping = (s: any) => {
		try { return String(s).trim().replace(/[, _]/g, ''); } catch { return ''; }
	};
	const isNumericString = (s: any) => {
		try {
			const t = stripNumericGrouping(s);
			if (!t) return false;
			return /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(t);
		} catch { return false; }
	};
	const tryParseDateMs = (v: any): number | null => {
		try {
			if (v instanceof Date) {
				const t = v.getTime();
				return isFinite(t) ? t : null;
			}
			const s = String(v).trim();
			if (!s) return null;
			if (isNumericString(s)) return null;
			let t = Date.parse(s);
			if (isFinite(t)) return t;
			let iso = s;
			if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
				iso = iso.replace(' ', 'T');
			}
			iso = iso.replace(/\.(\d{3})\d+/, '.$1');
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(iso)) {
				iso = iso + 'Z';
			}
			t = Date.parse(iso);
			return isFinite(t) ? t : null;
		} catch { return null; }
	};
	const stableStringify = (obj: any): string => {
		const seen = new Set();
		const walk = (v: any): any => {
			if (v === null || v === undefined) return v;
			const t = typeof v;
			if (t === 'string' || t === 'number' || t === 'boolean') return v;
			if (v instanceof Date) {
				const ms = v.getTime();
				return isFinite(ms) ? { $date: ms } : { $date: String(v) };
			}
			if (t !== 'object') return String(v);
			if (seen.has(v)) return '[circular]';
			seen.add(v);
			if (Array.isArray(v)) return v.map(walk);
			const out: any = {};
			for (const k of Object.keys(v).sort()) {
				try { out[k] = walk(v[k]); } catch { out[k] = '[unreadable]'; }
			}
			seen.delete(v);
			return out;
		};
		try { return JSON.stringify(walk(obj)); } catch {
			try { return String(obj); } catch { return '[unstringifiable]'; }
		}
	};
	const normalize = (v: any): any => {
		try {
			if (v === null || v === undefined) return ['n', null];
			const t = typeof v;
			if (t === 'number') return ['num', isFinite(v) ? v : String(v)];
			if (t === 'boolean') return ['bool', v ? 1 : 0];
			if (t === 'string') {
				const s = String(v);
				if (isNumericString(s)) {
					const num = parseFloat(stripNumericGrouping(s));
					if (isFinite(num)) return ['num', num];
				}
				const ms = tryParseDateMs(s);
				if (ms !== null) return ['date', ms];
				return ['str', s];
			}
			if (v instanceof Date) {
				const ms = v.getTime();
				return ['date', isFinite(ms) ? ms : String(v)];
			}
			if (t !== 'object') return ['p', t, String(v)];
			if (v && typeof v === 'object' && 'full' in v && v.full !== undefined && v.full !== null) {
				return normalize(v.full);
			}
			if (v && typeof v === 'object' && 'display' in v && v.display !== undefined && v.display !== null) {
				return normalize(v.display);
			}
			return ['obj', stableStringify(v)];
		} catch {
			try { return ['obj', String(v)]; } catch { return ['obj', '[uncomparable]']; }
		}
	};
	try {
		return normalize(cell);
	} catch {
		try { return ['obj', String(cell)]; } catch { return ['obj', '[uncomparable]']; }
	}
}

export function rowKeyForComparison(row: any): string {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = r.map(normalizeCellForComparison);
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

export function normalizeColumnNameForComparison(name: any): string {
	try {
		if (name && typeof name === 'object' && 'name' in name) {
			return String(name.name === null || name.name === undefined ? '' : name.name).trim().toLowerCase();
		}
		return String(name === null || name === undefined ? '' : name).trim().toLowerCase();
	} catch { return ''; }
}

export function getNormalizedColumnNameList(state: any): string[] {
	try {
		const cols = Array.isArray(state && state.columns) ? state.columns : [];
		return cols.map(normalizeColumnNameForComparison);
	} catch { return []; }
}

export function doColumnHeaderNamesMatch(sourceState: any, comparisonState: any): boolean {
	try {
		const a = getNormalizedColumnNameList(sourceState).slice().sort();
		const b = getNormalizedColumnNameList(comparisonState).slice().sort();
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch { return false; }
}

export function getColumnDifferences(sourceState: any, comparisonState: any): { onlyInA: string[]; onlyInB: string[] } {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		const aNorm = aCols.map(normalizeColumnNameForComparison);
		const bNorm = bCols.map(normalizeColumnNameForComparison);
		const aSet = new Set(aNorm);
		const bSet = new Set(bNorm);
		const onlyInA: string[] = [];
		const onlyInB: string[] = [];
		for (let i = 0; i < aCols.length; i++) {
			if (!bSet.has(aNorm[i])) onlyInA.push(String(aCols[i]));
		}
		for (let i = 0; i < bCols.length; i++) {
			if (!aSet.has(bNorm[i])) onlyInB.push(String(bCols[i]));
		}
		return { onlyInA, onlyInB };
	} catch { return { onlyInA: [], onlyInB: [] }; }
}

export function doColumnOrderMatch(sourceState: any, comparisonState: any): boolean {
	try {
		const a = getNormalizedColumnNameList(sourceState);
		const b = getNormalizedColumnNameList(comparisonState);
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch { return false; }
}

export function buildColumnIndexMapForNames(state: any): Map<string, number[]> {
	const cols = Array.isArray(state && state.columns) ? state.columns : [];
	const map = new Map<string, number[]>();
	for (let i = 0; i < cols.length; i++) {
		const n = normalizeColumnNameForComparison(cols[i]);
		if (!map.has(n)) map.set(n, []);
		map.get(n)!.push(i);
	}
	return map;
}

export function buildNameBasedColumnMapping(state: any, canonicalNames: string[]): number[] {
	try {
		const map = buildColumnIndexMapForNames(state);
		const mapping: number[] = [];
		for (const name of canonicalNames) {
			const list = map.get(name) || [];
			mapping.push(list.length ? list.shift()! : -1);
			map.set(name, list);
		}
		return mapping;
	} catch { return []; }
}

export function rowKeyForComparisonWithColumnMapping(row: any, mapping: any): string {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = (mapping || []).map((idx: any) => normalizeCellForComparison(idx >= 0 ? r[idx] : undefined));
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

export function rowKeyForComparisonIgnoringColumnOrder(row: any): string {
	try {
		const r = Array.isArray(row) ? row : [];
		const parts = r.map(normalizeCellForComparison).map((c: any) => {
			try { return JSON.stringify(c); } catch { return String(c); }
		});
		parts.sort();
		return JSON.stringify(parts);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

export function doRowOrderMatch(sourceState: any, comparisonState: any): boolean {
	try {
		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) return false;
		const columnHeaderNamesMatch = doColumnHeaderNamesMatch(sourceState, comparisonState);
		if (!columnHeaderNamesMatch) return false;
		const canonicalNames = getNormalizedColumnNameList(sourceState).slice().sort();
		const aMap = buildNameBasedColumnMapping(sourceState, canonicalNames);
		const bMap = buildNameBasedColumnMapping(comparisonState, canonicalNames);
		const rowKeyForA = (row: any) => rowKeyForComparisonWithColumnMapping(row, aMap);
		const rowKeyForB = (row: any) => rowKeyForComparisonWithColumnMapping(row, bMap);
		for (let i = 0; i < aRows.length; i++) {
			if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) return false;
		}
		return true;
	} catch { return false; }
}

export interface ResultEquivalenceDetails {
	dataMatches: boolean;
	rowOrderMatches: boolean;
	columnOrderMatches: boolean;
	columnHeaderNamesMatch: boolean;
	reason?: string;
	columnCountA?: number;
	columnCountB?: number;
	rowCountA?: number;
	rowCountB?: number;
	firstMismatchedRowKey?: string;
}

export function areResultsEquivalentWithDetails(sourceState: any, comparisonState: any): ResultEquivalenceDetails {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) {
			return {
				dataMatches: false, rowOrderMatches: false, columnOrderMatches: false,
				columnHeaderNamesMatch: false, reason: 'columnCountMismatch',
				columnCountA: aCols.length, columnCountB: bCols.length
			};
		}
		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) {
			return {
				dataMatches: false, rowOrderMatches: false, columnOrderMatches: false,
				columnHeaderNamesMatch: doColumnHeaderNamesMatch(sourceState, comparisonState),
				reason: 'rowCountMismatch', rowCountA: aRows.length, rowCountB: bRows.length
			};
		}
		const columnHeaderNamesMatch = doColumnHeaderNamesMatch(sourceState, comparisonState);
		const columnOrderMatches = doColumnOrderMatch(sourceState, comparisonState);

		let rowKeyForA: (row: any) => string;
		let rowKeyForB: (row: any) => string;
		let rowOrderMatches = false;

		if (columnHeaderNamesMatch) {
			const canonicalNames = getNormalizedColumnNameList(sourceState).slice().sort();
			const aMap = buildNameBasedColumnMapping(sourceState, canonicalNames);
			const bMap = buildNameBasedColumnMapping(comparisonState, canonicalNames);
			rowKeyForA = (row: any) => rowKeyForComparisonWithColumnMapping(row, aMap);
			rowKeyForB = (row: any) => rowKeyForComparisonWithColumnMapping(row, bMap);
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) { rowOrderMatches = false; break; }
			}
		} else {
			rowKeyForA = rowKeyForComparisonIgnoringColumnOrder;
			rowKeyForB = rowKeyForComparisonIgnoringColumnOrder;
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) { rowOrderMatches = false; break; }
			}
		}

		const counts = new Map<string, number>();
		for (const row of aRows) {
			const key = rowKeyForA(row);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		for (const row of bRows) {
			const key = rowKeyForB(row);
			const prev = counts.get(key) || 0;
			if (prev <= 0) {
				return {
					dataMatches: false, rowOrderMatches, columnOrderMatches,
					columnHeaderNamesMatch, reason: 'extraOrMismatchedRow', firstMismatchedRowKey: key
				};
			}
			if (prev === 1) counts.delete(key);
			else counts.set(key, prev - 1);
		}
		const dataMatches = counts.size === 0;
		if (!dataMatches) {
			let firstMissingKey = '';
			try { for (const k of counts.keys()) { firstMissingKey = k; break; } } catch { /* ignore */ }
			return {
				dataMatches, rowOrderMatches, columnOrderMatches,
				columnHeaderNamesMatch, reason: 'missingRow', firstMismatchedRowKey: firstMissingKey
			};
		}
		return { dataMatches, rowOrderMatches, columnOrderMatches, columnHeaderNamesMatch };
	} catch {
		return { dataMatches: false, rowOrderMatches: false, columnOrderMatches: false, columnHeaderNamesMatch: false, reason: 'exception' };
	}
}

export function areResultsEquivalent(sourceState: any, comparisonState: any): boolean {
	try { return !!areResultsEquivalentWithDetails(sourceState, comparisonState).dataMatches; } catch { return false; }
}

export function doResultHeadersMatch(sourceState: any, comparisonState: any): boolean {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) return false;
		for (let i = 0; i < aCols.length; i++) {
			if (String(aCols[i]) !== String(bCols[i])) return false;
		}
		return true;
	} catch { return false; }
}

// Section naming helpers

export function indexToAlphaName(index: any): string {
	try {
		let n = Math.max(0, Math.floor(Number(index) || 0));
		let out = '';
		while (true) {
			const r = n % 26;
			out = String.fromCharCode(65 + r) + out;
			n = Math.floor(n / 26) - 1;
			if (n < 0) break;
		}
		return out || 'A';
	} catch { return 'A'; }
}

export function getRunModeLabelText(mode: any): string {
	switch ((mode || '').toLowerCase()) {
		case 'plain': return 'Run Query';
		case 'sample100': return 'Run Query (sample 100)';
		case 'runfunction': return 'Run Function';
		case 'take100':
		default: return 'Run Query (take 100)';
	}
}

export function formatElapsed(ms: any): string {
	try {
		const totalMs = Math.max(0, Math.floor(Number(ms) || 0));
		const totalSec = Math.floor(totalMs / 1000);
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		return mins + ':' + String(secs).padStart(2, '0');
	} catch { return '0:00'; }
}

export function isValidConnectionIdForRun(connectionId: any): boolean {
	const id = String(connectionId || '').trim();
	if (!id) return false;
	if (id === '__prompt__' || id === '__enter_new__' || id === '__import_xml__') return false;
	return true;
}
