import { describe, expect, it } from 'vitest';
import { extractCrossClusterRefs, extractCrossClusterRefsWithRanges, getCrossClusterSchemaCheckDelay } from '../../src/webview/shared/cross-cluster-schema';

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

	it('range extraction returns every occurrence without deduping', () => {
		const query = `cluster('Remote').database('Telemetry').Events
| union cluster('Remote').database('Telemetry').MoreEvents`;
		const refs = extractCrossClusterRefsWithRanges(query, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toHaveLength(2);
		expect(refs.map(ref => ({ clusterName: ref.clusterName, database: ref.database }))).toEqual([
			{ clusterName: 'Remote', database: 'Telemetry' },
			{ clusterName: 'Remote', database: 'Telemetry' },
		]);
		expect(query.slice(...refs[1].clusterNameRange!)).toBe('Remote');
		expect(query.slice(...refs[1].databaseNameRange)).toBe('Telemetry');
		expect(query.slice(...refs[1].range)).toBe("cluster('Remote').database('Telemetry')");
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

	it('skips current regional cluster when query uses short name and context uses full ADX host', () => {
		const refs = extractCrossClusterRefs(`
			let baseQuery = materialize(cluster('semantic-current.westus').database('TelemetryDb').v_autocomplete_events()
			| where TIMESTAMP >= startTime)
		`, { clusterUrl: 'https://semantic-current.westus.kusto.windows.net', database: 'TelemetryDb' });

		expect(refs).toEqual([]);
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

	it('does not pair cluster with a later unrelated database call', () => {
		const refs = extractCrossClusterRefs(`
			cluster('Remote').foo().database('Ignored').Events
			| union cluster('Remote2'). /* database('Commented') */ database('Telemetry').Events
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([]);
	});

	it('extracts quoted cluster and database names that contain spaces', () => {
		const refs = extractCrossClusterRefs(`
			cluster("Remote Cluster").database("Telemetry Db").Events
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: 'Remote Cluster', database: 'Telemetry Db' }]);
	});

	it('extracts quoted names with escaped quote characters', () => {
		const refs = extractCrossClusterRefs(`
			cluster('Remote''Prod').database('Telemetry''Db').Events
			| union cluster("Remote\\"Canary").database("Telemetry\\"Db").Events
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([
			{ clusterName: "Remote'Prod", database: "Telemetry'Db" },
			{ clusterName: 'Remote"Canary', database: 'Telemetry"Db' },
		]);
	});

	it('range extraction preserves quoted source spans when values contain escaped quotes', () => {
		const query = `cluster('Remote''Prod').database("Telemetry\\\"Db").Events`;
		const refs = extractCrossClusterRefsWithRanges(query, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toHaveLength(1);
		expect(refs[0].clusterName).toBe("Remote'Prod");
		expect(refs[0].database).toBe('Telemetry"Db');
		expect(query.slice(...refs[0].clusterNameRange!)).toBe("Remote''Prod");
		expect(query.slice(...refs[0].databaseNameRange)).toBe('Telemetry\\"Db');
	});

	it('extracts fully qualified references inside function bodies and wrappers', () => {
		const refs = extractCrossClusterRefs(`
			.create-or-alter function with (folder = "debug") MyFn() {
				let remoteRows = materialize(cluster("Remote").database("Telemetry").Events | where EventId > 0);
				remoteRows
				| join kind=leftouter (cluster('Remote2').database('Telemetry2').Lookups) on EventId
				| project EventId, Name
			}
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([
			{ clusterName: 'Remote', database: 'Telemetry' },
			{ clusterName: 'Remote2', database: 'Telemetry2' },
		]);
	});

	it('extracts full regional ADX host references inside materialize', () => {
		const refs = extractCrossClusterRefs(`
			let eventRows =
				materialize(cluster('semantic-remote.westus.kusto.windows.net').database('TelemetryDb').Events
				| where TIMESTAMP >= startTime and TIMESTAMP < endTime
				| where EventName == "ResponseCompleted")
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: 'semantic-remote.westus.kusto.windows.net', database: 'TelemetryDb' }]);
	});

	it('ignores cluster/database text in comments and standalone strings', () => {
		const refs = extractCrossClusterRefs(`
			// cluster("Commented").database("Ignored").Table
			print text = "cluster('Literal').database('Ignored').Table"
			/* database("AlsoIgnored").Table */
			cluster("Remote").database("Telemetry").Events
		`, { clusterUrl: 'https://current.kusto.windows.net', database: 'CurrentDb' });

		expect(refs).toEqual([{ clusterName: 'Remote', database: 'Telemetry' }]);
	});

	it('defers schema checks until the editor has been idle long enough', () => {
		expect(getCrossClusterSchemaCheckDelay(10_100, 10_000, 1_200)).toBe(1_100);
		expect(getCrossClusterSchemaCheckDelay(11_200, 10_000, 1_200)).toBe(0);
		expect(getCrossClusterSchemaCheckDelay(10_100, 0, 1_200)).toBe(0);
	});
});