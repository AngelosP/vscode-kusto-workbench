import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';
import { getKustoPreparationState } from './state.js';

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
		if (el && String(el.tagName || '').toLowerCase() === 'kw-query-section'
			&& typeof el.getConnectionId === 'function') return el;
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

export function synchronizeKustoSectionTarget(sourceBoxId: unknown, targetBoxId: unknown): boolean {
	const source = __kustoGetQuerySectionElement(sourceBoxId);
	const target = __kustoGetQuerySectionElement(targetBoxId);
	if (!source || !target) return false;
	const connectionId = String(source.getConnectionId?.() || '').trim();
	const database = String(source.getDatabase?.() || '').trim();
	const clusterKey = kustoClusterKey(String(source.getClusterUrl?.() || ''));
	try {
		const alreadySynchronized = String(target.getConnectionId?.() || '').trim() === connectionId
			&& String(target.getDatabase?.() || '').trim().toLowerCase() === database.toLowerCase()
			&& kustoClusterKey(String(target.getClusterUrl?.() || '')) === clusterKey;
		const completeDatabaseTransition = () => {
			if (!database) return;
			target.setDatabase?.(database);
			target.clearDesiredDatabase?.();
			target.dispatchEvent(new CustomEvent('database-changed', {
				detail: { boxId: String(targetBoxId || ''), database, source: 'comparison-sync' },
				bubbles: true,
				composed: true,
			}));
		};
		if (alreadySynchronized) {
			const preparation = getKustoPreparationState(String(targetBoxId || ''));
			if (preparation.status === 'preparing' && preparation.blockers.includes('databases')) {
				completeDatabaseTransition();
			}
			return true;
		}
		target.clearTargetBoundState?.();
		target.setConnectionId?.(connectionId);
		if (database) target.setDesiredDatabase?.(database);
		else target.clearDesiredDatabase?.();
		target.setSchemaLifecycleTarget?.(connectionId, database || undefined);
		completeDatabaseTransition();
	} catch (e) {
		console.error('[kusto]', e);
		return false;
	}
	return String(target.getConnectionId?.() || '').trim() === connectionId
		&& String(target.getDatabase?.() || '').trim().toLowerCase() === database.toLowerCase()
		&& kustoClusterKey(String(target.getClusterUrl?.() || '')) === clusterKey;
}

try {
	window.__kustoGetConnectionId = __kustoGetConnectionId;
	window.__kustoGetDatabase = __kustoGetDatabase;
	window.__kustoGetClusterUrl = __kustoGetClusterUrl;
	window.__kustoGetQuerySectionElement = __kustoGetQuerySectionElement;
} catch (e) { console.error('[kusto]', e); }