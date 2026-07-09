import { extractCrossClusterRefsWithRanges, type CrossClusterSchemaContext } from './cross-cluster-schema';
import { kustoDatabaseKey } from '../../shared/kustoClusterUrls.js';

export type KustoDiagnosticMarkerLike = {
	code?: unknown;
	message?: unknown;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
};

export type KustoMarkerFilterTrace = {
	event: 'suppress-loaded-cross-cluster-ks207';
	code: string;
	schemaKey: string;
};

function markerCodeValue(code: unknown): string {
	if (typeof code === 'string' || typeof code === 'number') {
		return String(code);
	}
	if (code && typeof code === 'object') {
		const value = (code as { value?: unknown }).value;
		if (typeof value === 'string' || typeof value === 'number') {
			return String(value);
		}
	}
	return '';
}

export function isKustoUnreachableClusterMarker(marker: { code?: unknown; message?: unknown }): boolean {
	const code = markerCodeValue(marker?.code).toUpperCase();
	if (code === 'KS207') {
		return true;
	}
	if (code) {
		return false;
	}
	const message = String(marker?.message || '').toLowerCase();
	return message.includes('does not refer to a reachable cluster')
		|| (message.includes('no schema from it') && message.includes('currently available'));
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
	return a[0] < b[1] && b[0] < a[1];
}

export function filterLoadedCrossClusterKs207Markers<T extends KustoDiagnosticMarkerLike>(
	text: string,
	markers: T[],
	options: {
		modelUri: string;
		currentContext?: CrossClusterSchemaContext | null;
		getOffsetAt(position: { lineNumber: number; column: number }): number;
		isSchemaLoadedForModel(schemaKey: string, modelUri: string): boolean;
		trace?: (event: KustoMarkerFilterTrace) => void;
	}
): T[] {
	if (!Array.isArray(markers) || markers.length === 0 || !options.modelUri) {
		return markers;
	}
	const candidateMarkers = markers.filter(isKustoUnreachableClusterMarker);
	if (candidateMarkers.length === 0) {
		return markers;
	}
	const refs = extractCrossClusterRefsWithRanges(text, options.currentContext);
	if (refs.length === 0) {
		return markers;
	}
	return markers.filter(marker => {
		if (!isKustoUnreachableClusterMarker(marker)) {
			return true;
		}
		let markerRange: [number, number];
		try {
			const start = options.getOffsetAt({ lineNumber: marker.startLineNumber, column: marker.startColumn });
			const end = options.getOffsetAt({ lineNumber: marker.endLineNumber, column: marker.endColumn });
			markerRange = [Math.min(start, end), Math.max(start, end) || Math.min(start, end) + 1];
		} catch {
			return true;
		}
		for (const ref of refs) {
			if (!ref.clusterName) {
				continue;
			}
			const overlapsRef = rangesOverlap(markerRange, ref.range)
				|| (!!ref.clusterNameRange && rangesOverlap(markerRange, ref.clusterNameRange));
			if (!overlapsRef) {
				continue;
			}
			const schemaKey = kustoDatabaseKey(ref.clusterName, ref.database);
			if (schemaKey && options.isSchemaLoadedForModel(schemaKey, options.modelUri)) {
				options.trace?.({ event: 'suppress-loaded-cross-cluster-ks207', code: markerCodeValue(marker.code), schemaKey });
				return false;
			}
		}
		return true;
	});
}
