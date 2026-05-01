import { describe, expect, it } from 'vitest';
import { extractCrossClusterRefs, getCrossClusterSchemaCheckDelay } from '../../src/webview/shared/cross-cluster-schema';

describe('cross-cluster schema helpers', () => {
	it('extracts and deduplicates fully qualified cluster/database references', () => {
		const refs = extractCrossClusterRefs(`
			cluster('OtherCluster').database('Telemetry').Events
			| union cluster("OtherCluster").database("Telemetry").MoreEvents
			| union cluster(UnquotedCluster).database(UnquotedDb).Table
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([
			{ clusterName: 'OtherCluster', database: 'Telemetry' },
			{ clusterName: 'UnquotedCluster', database: 'UnquotedDb' },
		]);
	});

	it('skips references that already match the current context', () => {
		const refs = extractCrossClusterRefs(`
			cluster('Current').database('CurrentDb').Events
			| union cluster('current.kusto.windows.net').database('CurrentDb').OtherEvents
			| union cluster('https://current.kusto.windows.net/').database('CurrentDb').ProtocolQualified
			| union cluster('Remote').database('CurrentDb').RemoteEvents
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: 'Remote', database: 'CurrentDb' }]);
	});

	it('keeps same-cluster database-only references as null-cluster refs', () => {
		const refs = extractCrossClusterRefs(`
			database('CurrentDb').AlreadyLoaded
			| union database("OtherDb").Events
			| union database(OtherDb).MoreEvents
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: null, database: 'OtherDb' }]);
	});

	it('does not duplicate fully qualified refs with whitespace around the dot', () => {
		const refs = extractCrossClusterRefs(`
			cluster( 'Remote' ) . database( 'Telemetry' ) . Events
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: 'Remote', database: 'Telemetry' }]);
	});

	it('defers schema checks until the editor has been idle long enough', () => {
		expect(getCrossClusterSchemaCheckDelay(10_100, 10_000, 1_200)).toBe(1_100);
		expect(getCrossClusterSchemaCheckDelay(11_200, 10_000, 1_200)).toBe(0);
		expect(getCrossClusterSchemaCheckDelay(10_100, 0, 1_200)).toBe(0);
	});
});