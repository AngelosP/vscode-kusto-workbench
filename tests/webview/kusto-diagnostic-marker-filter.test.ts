import { describe, expect, it, vi } from 'vitest';
import { filterLoadedCrossClusterKs207Markers } from '../../src/webview/shared/kusto-diagnostic-marker-filter';
import { kustoDatabaseKey } from '../../src/shared/kustoClusterUrls';

type Marker = {
	code?: unknown;
	message?: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
};

function offsetAt(text: string, position: { lineNumber: number; column: number }): number {
	const lines = text.split('\n');
	let offset = 0;
	for (let i = 1; i < position.lineNumber; i++) {
		offset += (lines[i - 1] || '').length + 1;
	}
	return offset + Math.max(0, position.column - 1);
}

function markerOn(text: string, needle: string, code: unknown = 'KS207'): Marker {
	const start = text.indexOf(needle);
	if (start < 0) throw new Error(`needle not found: ${needle}`);
	const before = text.slice(0, start).split('\n');
	const lineNumber = before.length;
	const column = before[before.length - 1].length + 1;
	return {
		code,
		message: `The name '${needle}' either does not refer to a reachable cluster or no schema from it is currently available.`,
		startLineNumber: lineNumber,
		startColumn: column,
		endLineNumber: lineNumber,
		endColumn: column + needle.length,
	};
}

function markerOnLast(text: string, needle: string, code: unknown = 'KS207'): Marker {
	const start = text.lastIndexOf(needle);
	if (start < 0) throw new Error(`needle not found: ${needle}`);
	const before = text.slice(0, start).split('\n');
	const lineNumber = before.length;
	const column = before[before.length - 1].length + 1;
	return {
		code,
		message: `The name '${needle}' either does not refer to a reachable cluster or no schema from it is currently available.`,
		startLineNumber: lineNumber,
		startColumn: column,
		endLineNumber: lineNumber,
		endColumn: column + needle.length,
	};
}

describe('filterLoadedCrossClusterKs207Markers', () => {
	const modelUri = 'inmemory://model/1';
	const currentContext = { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' };

	it('suppresses KS207 only when the exact cross-cluster schema is loaded for the model', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'Remote');
		const trace = vi.fn();
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: (key, uri) => key === kustoDatabaseKey('Remote', 'Telemetry') && uri === modelUri,
			trace,
		});

		expect(result).toEqual([]);
		expect(trace).toHaveBeenCalledWith({ event: 'suppress-loaded-cross-cluster-ks207', code: 'KS207', schemaKey: kustoDatabaseKey('Remote', 'Telemetry') });
	});

	it('keeps KS207 when the schema is not loaded for the model', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'Remote');
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: () => false,
		});

		expect(result).toEqual([marker]);
	});

	it('suppresses marker on the second duplicate occurrence', () => {
		const text = `cluster('Remote').database('Telemetry').Events\n| union cluster('Remote').database('Telemetry').MoreEvents`;
		const secondStart = text.lastIndexOf('Remote');
		const prefix = text.slice(0, secondStart).split('\n');
		const marker: Marker = {
			code: { value: 'KS207', target: 'https://example.invalid' },
			message: `The name 'Remote' either does not refer to a reachable cluster or no schema from it is currently available.`,
			startLineNumber: prefix.length,
			startColumn: prefix[prefix.length - 1].length + 1,
			endLineNumber: prefix.length,
			endColumn: prefix[prefix.length - 1].length + 1 + 'Remote'.length,
		};
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: key => key === kustoDatabaseKey('Remote', 'Telemetry'),
		});

		expect(result).toEqual([]);
	});

	it('keeps unrelated marker codes even when they overlap a loaded ref', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'Remote', 'KW_UNKNOWN_TABLE');
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: () => true,
		});

		expect(result).toEqual([marker]);
	});

	it('keeps KS207 when model URI is unavailable', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'Remote');
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri: '',
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: () => true,
		});

		expect(result).toEqual([marker]);
	});

	it('supports message-only unreachable-cluster markers when no explicit code exists', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'Remote');
		delete marker.code;
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: key => key === kustoDatabaseKey('Remote', 'Telemetry'),
		});

		expect(result).toEqual([]);
	});

	it('keeps non-overlapping KS207 markers even when another loaded ref exists', () => {
		const text = `MissingCluster\n| union cluster('Remote').database('Telemetry').Events`;
		const marker = markerOn(text, 'MissingCluster');
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: key => key === kustoDatabaseKey('Remote', 'Telemetry'),
		});

		expect(result).toEqual([marker]);
	});

	it('keeps database-only reference markers out of cross-cluster suppression', () => {
		const text = `database('OtherDb').Events`;
		const marker = markerOn(text, 'OtherDb');
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: () => true,
		});

		expect(result).toEqual([marker]);
	});

	it('suppresses marker covering the quoted cluster string inside a loaded ref', () => {
		const text = `cluster('Remote').database('Telemetry').Events`;
		const marker = markerOnLast(text, `'Remote'`);
		const result = filterLoadedCrossClusterKs207Markers(text, [marker], {
			modelUri,
			currentContext,
			getOffsetAt: position => offsetAt(text, position),
			isSchemaLoadedForModel: key => key === kustoDatabaseKey('Remote', 'Telemetry'),
		});

		expect(result).toEqual([]);
	});
});
