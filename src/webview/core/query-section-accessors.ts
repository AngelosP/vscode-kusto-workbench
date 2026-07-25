export function __kustoGetConnectionId(boxId: unknown): string {
	try {
		const el = document.getElementById(String(boxId || '')) as any;
		if (el && typeof el.getConnectionId === 'function') return String(el.getConnectionId() || '');
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetDatabase(boxId: unknown): string {
	try {
		const el = document.getElementById(String(boxId || '')) as any;
		if (el && typeof el.getDatabase === 'function') return String(el.getDatabase() || '');
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetClusterUrl(boxId: unknown): string {
	try {
		const el = document.getElementById(String(boxId || '')) as any;
		if (el && typeof el.getClusterUrl === 'function') return String(el.getClusterUrl() || '');
	} catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoGetQuerySectionElement(boxId: unknown): any | null {
	try {
		const el = document.getElementById(String(boxId || '')) as any;
		if (el && typeof el.getConnectionId === 'function') return el;
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

try {
	window.__kustoGetConnectionId = __kustoGetConnectionId;
	window.__kustoGetDatabase = __kustoGetDatabase;
	window.__kustoGetClusterUrl = __kustoGetClusterUrl;
	window.__kustoGetQuerySectionElement = __kustoGetQuerySectionElement;
} catch (e) { console.error('[kusto]', e); }