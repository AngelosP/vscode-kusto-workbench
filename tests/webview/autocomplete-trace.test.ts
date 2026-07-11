import { beforeEach, describe, expect, it } from 'vitest';

import {
	clearAutocompleteTrace,
	finishAutocompleteTrace,
	getAutocompleteTrace,
	recordAutocompleteTrace,
	startAutocompleteTrace,
} from '../../src/webview/monaco/autocomplete-trace';

describe('autocomplete trace privacy', () => {
	beforeEach(() => clearAutocompleteTrace());

	it('keeps lifecycle evidence while hashing identifiers and collapsing samples', () => {
		const traceId = startAutocompleteTrace({
			boxId: 'SENTINEL_BOX',
			modelUri: 'file:///SENTINEL_PATH/query.kql',
			clusterUrl: 'https://SENTINEL_CLUSTER.kusto.windows.net',
			database: 'SENTINEL_DATABASE',
			position: { lineNumber: 4, column: 9 },
		});
		recordAutocompleteTrace(traceId, 'supplemental-columns', {
			schemaKey: 'SENTINEL_CLUSTER|SENTINEL_DATABASE',
			entityName: 'SENTINEL_TABLE',
			columns: ['SENTINEL_COLUMN', 'OtherColumn'],
			aliases: ['SENTINEL_ALIAS'],
			columnCount: 2,
			hasRawSchema: true,
			status: 'loaded',
		});
		finishAutocompleteTrace(traceId, 'success', { reason: 'completed', labels: ['SENTINEL_COLUMN'] });

		const trace = getAutocompleteTrace(traceId);
		const text = JSON.stringify(trace);
		for (const sentinel of [
			'SENTINEL_BOX',
			'SENTINEL_PATH',
			'SENTINEL_CLUSTER',
			'SENTINEL_DATABASE',
			'SENTINEL_TABLE',
			'SENTINEL_COLUMN',
			'SENTINEL_ALIAS',
		]) {
			expect(text).not.toContain(sentinel);
		}
		expect(trace).toMatchObject({ status: 'success' });
		expect((trace as any).events.map((event: any) => event.event)).toEqual([
			'trace-start',
			'supplemental-columns',
			'trace-finish',
		]);
		const columnsEvent = (trace as any).events.find((event: any) => event.event === 'supplemental-columns');
		expect(columnsEvent.detail).toMatchObject({
			columnCount: 2,
			columnsCount: 2,
			aliasesCount: 1,
			hasRawSchema: true,
			status: 'loaded',
		});
		expect(columnsEvent.detail.schemaKeyId).toMatch(/^[a-f0-9]{8}$/);
		expect(columnsEvent.detail.entityNameId).toMatch(/^[a-f0-9]{8}$/);
	});
});
