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
	event: 'suppress-supplemental-diagnostic';
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

export function getKustoSupplementalDiagnosticCode(marker: { code?: unknown }): 'KS207' | 'KS208' | '' {
	const code = markerCodeValue(marker?.code).toUpperCase();
	return code === 'KS207' || code === 'KS208' ? code : '';
}

function rangeContains(outer: [number, number], inner: [number, number]): boolean {
	return inner[0] >= outer[0] && inner[1] <= outer[1];
}

export function filterResolvableCrossClusterMarkers<T extends KustoDiagnosticMarkerLike>(
	text: string,
	markers: T[],
	options: {
		modelUri: string;
		currentContext?: CrossClusterSchemaContext | null;
		getOffsetAt(position: { lineNumber: number; column: number }): number;
		shouldSuppressDiagnostic(schemaKey: string, modelUri: string): boolean;
		trace?: (event: KustoMarkerFilterTrace) => void;
	}
): T[] {
	if (!Array.isArray(markers) || markers.length === 0 || !options.modelUri) {
		return markers;
	}
	const candidateMarkers = markers.filter(marker => !!getKustoSupplementalDiagnosticCode(marker));
	if (candidateMarkers.length === 0) {
		return markers;
	}
	const refs = extractCrossClusterRefsWithRanges(text, options.currentContext);
	if (refs.length === 0) {
		return markers;
	}
	return markers.filter(marker => {
		const code = getKustoSupplementalDiagnosticCode(marker);
		if (!code) {
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
			const targetRange = code === 'KS207'
				? ref.clusterCallRange || ref.clusterNameRange
				: ref.databaseCallRange || ref.databaseNameRange;
			if (!targetRange || !rangeContains(targetRange, markerRange)) {
				continue;
			}
			const schemaKey = kustoDatabaseKey(ref.clusterName, ref.database);
			if (schemaKey && options.shouldSuppressDiagnostic(schemaKey, options.modelUri)) {
				options.trace?.({ event: 'suppress-supplemental-diagnostic', code, schemaKey });
				return false;
			}
		}
		return true;
	});
}

export const filterLoadedCrossClusterKs207Markers = filterResolvableCrossClusterMarkers;
