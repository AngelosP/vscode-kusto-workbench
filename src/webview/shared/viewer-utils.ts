// Pure utility functions extracted from legacy viewer modules (cellViewer.ts, objectViewer.ts).
// No DOM access, no window globals.

/** Get the column name from a results state object. */
export function getColumnName(state: any, colIndex: number): string {
	try {
		const cols = (state && Array.isArray(state.columns)) ? state.columns : [];
		const col = cols[colIndex];
		if (typeof col === 'string') return col;
		if (col && typeof col === 'object') {
			if (typeof col.name === 'string' && col.name) return col.name;
			if (typeof col.columnName === 'string' && col.columnName) return col.columnName;
			if (typeof col.displayName === 'string' && col.displayName) return col.displayName;
		}
	} catch (e) { console.error('[kusto]', e); }
	return 'column ' + (colIndex + 1);
}

/** Try to parse a string as JSON. Returns the parsed value, or the original string if not JSON. */
export function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	const s = (value as string).trim();
	if (!s) {
		return value;
	}
	if (!(s.startsWith('{') || s.startsWith('[') || s === 'null' || s === 'true' || s === 'false' || /^-?\d/.test(s) || s.startsWith('"'))) {
		return value;
	}
	try {
		return JSON.parse(value as string);
	} catch {
		return value;
	}
}

/** Stringify a value for search purposes. */
export function stringifyForSearch(value: unknown): string {
	try {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Format a scalar value for table display. */
export function formatScalarForTable(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Check if a value is complex (object/array or JSON string containing one). */
export function isComplexValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') {
		const s = (value as string).trim();
		return s.startsWith('{') || s.startsWith('[');
	}
	return typeof value === 'object';
}

/** Syntax-highlight a JSON value as HTML. Requires escapeHtml function. */
export function syntaxHighlightJson(obj: unknown, indent = 0, escapeHtml: (s: string) => string = (s) => s): string {
	const indentStr = '  '.repeat(indent);
	const nextIndent = '  '.repeat(indent + 1);

	if (obj === null) {
		return '<span class="json-null">null</span>';
	}
	if (typeof obj === 'string') {
		return '<span class="json-string">"' + escapeHtml(obj) + '"</span>';
	}
	if (typeof obj === 'number') {
		return '<span class="json-number">' + obj + '</span>';
	}
	if (typeof obj === 'boolean') {
		return '<span class="json-boolean">' + obj + '</span>';
	}
	if (Array.isArray(obj)) {
		if (obj.length === 0) {
			return '[]';
		}
		let result = '[\n';
		obj.forEach((item, index) => {
			result += nextIndent + syntaxHighlightJson(item, indent + 1, escapeHtml);
			if (index < obj.length - 1) {
				result += ',';
			}
			result += '\n';
		});
		result += indentStr + ']';
		return result;
	}
	if (typeof obj === 'object') {
		const keys = Object.keys(obj as Record<string, unknown>);
		if (keys.length === 0) {
			return '{}';
		}
		let result = '{\n';
		keys.forEach((key, index) => {
			result += nextIndent + '<span class="json-key">"' + escapeHtml(key) + '"</span>: ';
			result += syntaxHighlightJson((obj as Record<string, unknown>)[key], indent + 1, escapeHtml);
			if (index < keys.length - 1) {
				result += ',';
			}
			result += '\n';
		});
		result += indentStr + '}';
		return result;
	}
	return String(obj);
}

/** Format a JSON value as syntax-highlighted HTML. */
export function formatJson(jsonString: unknown, escapeHtml: (s: string) => string = (s) => s): string {
	try {
		const obj = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
		return syntaxHighlightJson(obj, 0, escapeHtml);
	} catch {
		return '<span class="json-string">' + escapeHtml(String(jsonString)) + '</span>';
	}
}
